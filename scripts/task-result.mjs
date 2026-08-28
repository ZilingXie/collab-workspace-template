import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  fallbackSummaryPoints,
  normalizeSummaryPoints,
  readJson,
  relativePath,
  unique,
  writeJsonAtomic
} from "./card-v1-lib.mjs";
import { redactStructured, redactText } from "./analysis-security.mjs";

const resultSchemaVersion = 1;
const resultIdPattern = /^result-[A-Za-z0-9._-]+$/;

export function stableResultId({ taskId = "", relayTaskId = "", sourceMessageId = "", summary = "" } = {}) {
  const input = [taskId, relayTaskId, sourceMessageId, summary].join("\n");
  return `result-${createHash("sha256").update(input, "utf8").digest("hex").slice(0, 24)}`;
}

export function normalizeResultEnvelope(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const submittedText = String(source.submitted_text || source.raw_text || source.full_text || "").trim();
  const summary = String(source.summary || "").trim();
  const summaryPoints = normalizeSummaryPoints(source.summary_points || source.result?.summary_points, 3);
  const fallbackPoints = summaryPoints.length
    ? summaryPoints
    : fallbackSummaryPoints(submittedText || summary, "Task Result", 3);
  const artifacts = Array.isArray(source.artifact_refs || source.artifacts)
    ? (source.artifact_refs || source.artifacts).map(normalizeArtifact).filter((item) => item.path || item.url || item.artifact_id)
    : [];
  return {
    schema_version: Number(source.schema_version || resultSchemaVersion),
    result_id: String(source.result_id || "").trim(),
    task_id: String(source.task_id || "").trim(),
    relay_task_id: String(source.relay_task_id || "").trim(),
    source_message_id: String(source.source_message_id || "").trim(),
    submitted_by: String(source.submitted_by || source.from_agent_id || "").trim(),
    submitted_at: String(source.submitted_at || source.created_at || "").trim(),
    result_type: String(source.result_type || (artifacts.length && submittedText ? "mixed" : artifacts.length ? "artifact" : submittedText ? "inline" : "summary_only")),
    submitted_text: submittedText,
    summary,
    summary_points: fallbackPoints,
    verification: normalizeTextList(source.verification || source.result?.verification),
    blockers: normalizeTextList(source.blockers || source.result?.blockers),
    artifact_refs: artifacts,
    acceptance_status: String(source.acceptance_status || "accepted"),
    accepted_at: String(source.accepted_at || "").trim(),
    accepted_by: String(source.accepted_by || "Project Hermes").trim(),
    source_hash: String(source.source_hash || (submittedText ? sha256(submittedText) : "")).trim(),
    source_refs: normalizeTextList(source.source_refs),
    raw_source_path: String(source.raw_source_path || "").trim()
  };
}

export async function persistTaskResult(workspaceRoot, task, input = {}) {
  const normalized = normalizeResultEnvelope({
    ...input,
    task_id: input.task_id || task.task_id,
    relay_task_id: input.relay_task_id || task.relay_task_id,
    result_id: input.result_id || stableResultId({
      taskId: input.task_id || task.task_id,
      relayTaskId: input.relay_task_id || task.relay_task_id,
      sourceMessageId: input.source_message_id,
      summary: input.summary
    })
  });
  if (!resultIdPattern.test(normalized.result_id)) throw new Error("invalid task result id");
  const resultRoot = path.join(workspaceRoot, "09-tasks", "tasks", task.task_id, "results");
  const jsonPath = path.join(resultRoot, `${normalized.result_id}.json`);
  const markdownPath = path.join(resultRoot, `${normalized.result_id}.md`);
  await fs.mkdir(resultRoot, { recursive: true, mode: 0o2775 });
  const existing = await readJson(jsonPath, null);
  if (existing) {
    // A crashed write can leave the JSON envelope without its readable mirror.
    // Recreate only the missing mirror while keeping the original result immutable.
    try {
      await fs.access(markdownPath);
    } catch {
      await fs.writeFile(markdownPath, renderResultMarkdown(existing), { mode: 0o664 });
    }
    return {
      result: existing,
      result_path: relativePath(workspaceRoot, jsonPath),
      markdown_path: relativePath(workspaceRoot, markdownPath),
      deduplicated: true
    };
  }

  const redacted = redactStructured(normalized);
  const result = {
    ...redacted.value,
    schema_version: resultSchemaVersion,
    result_id: normalized.result_id,
    task_id: task.task_id,
    relay_task_id: normalized.relay_task_id || task.relay_task_id || null,
    full_text_path: relativePath(workspaceRoot, markdownPath),
    redaction_count: redacted.findings.length,
    redaction_types: [...new Set(redacted.findings.map((item) => item.type))],
    accepted_at: normalized.accepted_at || new Date().toISOString(),
    accepted_by: normalized.accepted_by || "Project Hermes"
  };
  await writeJsonAtomic(jsonPath, result, 0o664);
  await fs.writeFile(markdownPath, renderResultMarkdown(result), { mode: 0o664 });
  return {
    result,
    result_path: relativePath(workspaceRoot, jsonPath),
    markdown_path: relativePath(workspaceRoot, markdownPath),
    deduplicated: false
  };
}

export async function loadLatestTaskResult(workspaceRoot, task) {
  const resultPath = task?.latest_result_path || task?.result_path;
  if (!resultPath) return null;
  return readJson(path.resolve(workspaceRoot, resultPath), null);
}

export async function renderTaskCard(workspaceRoot, task, {
  role = task.task_role || "assignee",
  siblings = [],
  auditEntries = []
} = {}) {
  const result = await loadLatestTaskResult(workspaceRoot, task);
  const status = statusLabel(task.status);
  const points = normalizeSummaryPoints(result?.summary_points || task.result_summary_points, 3);
  const fallbackPoints = points.length ? points : (task.key_points?.length ? task.key_points : [task.content || "暂无任务说明。"]);
  const children = role === "coordinator" || role === "decomposer"
    ? siblings.map((item) => `- ${item.owner || "Project Hermes"}：${item.title}（${statusLabel(item.status)}，Task ID: ${item.task_id}）`)
    : [];
  const sourceRefs = unique([
    ...(task.source_refs || []),
    ...(result?.full_text_path ? [result.full_text_path] : [])
  ]);
  const body = [
    "---",
    `card_id: ${task.task_card_id}`,
    "card_type: task",
    `task_id: ${task.task_id}`,
    `task_role: ${role}`,
    `parent_task_id: ${task.parent_task_id || ""}`,
    `coordinator_task_id: ${task.coordinator_task_id || task.task_id}`,
    `human_event_id: ${(task.human_event_ids || [])[0] || ""}`,
    `topic_id: ${task.topic_id || ""}`,
    "placement_type: topic",
    `placement_id: ${task.topic_id || ""}`,
    "author: Hermes",
    `occurred_at: ${task.created_at}`,
    `updated_at: ${task.updated_at}`,
    `title: ${JSON.stringify(task.title)}`,
    "participants:",
    `  - ${task.owner || "未分配"}`,
    ...(sourceRefs.length ? ["source_refs:", ...sourceRefs.map((sourceRef) => `  - ${sourceRef}`)] : []),
    "---",
    "",
    `# ${task.title}`,
    "",
    "## 任务内容",
    `- ${task.content || "暂无任务说明。"}`,
    "",
    "## 当前状态",
    `- ${status}`,
    "",
    ...(task.collection_status ? ["## 收集结果", `- ${task.collection_status}`, `- ${task.summary || "等待到期收敛。"}`, ""] : []),
    ...(task.input_artifacts?.length ? [
      "## 输入材料",
      ...task.input_artifacts.map((artifact) => `- [${artifact.title}](${artifact.url || artifact.path})（${artifact.artifact_id}，SHA-256: ${artifact.sha256 || "未记录"}）`),
      ""
    ] : []),
    "## 结果摘要",
    ...(task.status === "completed" && result ? fallbackPoints.slice(0, 3).map((point) => `- ${point}`) : ["- 暂无已验收结果。"]),
    "",
    ...(result ? [
      "## 完整提交内容",
      result.submitted_text || "未提供 inline 文本；请查看 Artifact。",
      "",
      ...(result.artifact_refs?.length ? ["## Artifacts", ...result.artifact_refs.map(formatArtifactLine), ""] : []),
      ...(result.verification?.length ? ["## 验证结果", ...result.verification.map((item) => `- ${item}`), ""] : []),
      ...(result.blockers?.length ? ["## Blocker", ...result.blockers.map((item) => `- ${item}`), ""] : []),
      "## Result 来源",
      `- ${result.full_text_path}`,
      ""
    ] : []),
    ...(children.length ? ["## 子 Task", ...children, ""] : []),
    "## 完成标准",
    `- ${task.done_criteria || "暂无"}`,
    "",
    "## 审计时间线",
    ...auditEntries.map(formatAuditEntry),
    `- 完整审计：09-tasks/tasks/${task.task_id}/audit.jsonl`,
    ""
  ];
  const cardPath = path.join(workspaceRoot, "08-cards", "cards", `card-${task.task_card_id}.md`);
  await fs.mkdir(path.dirname(cardPath), { recursive: true, mode: 0o2775 });
  await fs.writeFile(cardPath, body.join("\n"), { mode: 0o664 });
  return cardPath;
}

export function renderResultMarkdown(result) {
  return [
    "---",
    `result_id: ${result.result_id}`,
    `task_id: ${result.task_id}`,
    `relay_task_id: ${result.relay_task_id || ""}`,
    `source_message_id: ${result.source_message_id || ""}`,
    `submitted_by: ${result.submitted_by || "未标注"}`,
    `submitted_at: ${result.submitted_at || ""}`,
    `result_type: ${result.result_type}`,
    `acceptance_status: ${result.acceptance_status}`,
    "---",
    "",
    `# Task Result ${result.result_id}`,
    "",
    "## 提交内容",
    result.submitted_text || "未提供 inline 文本。",
    "",
    "## Hermes 验收摘要",
    ...result.summary_points.map((point) => `- ${point}`),
    "",
    ...(result.artifact_refs?.length ? ["## Artifacts", ...result.artifact_refs.map(formatArtifactLine), ""] : []),
    ...(result.verification?.length ? ["## 验证结果", ...result.verification.map((item) => `- ${item}`), ""] : []),
    ...(result.blockers?.length ? ["## Blocker", ...result.blockers.map((item) => `- ${item}`), ""] : []),
    ""
  ].join("\n");
}

export function statusLabel(value) {
  return {
    ready: "待开始",
    dispatching: "派发中",
    processing: "进行中",
    in_progress: "进行中",
    completed: "完成",
    completed_before_dispatch: "完成",
    expired: "已到期",
    failed: "失败",
    cancelled: "已取消",
    superseded: "已被替代",
    waiting_collection: "收集中"
  }[value] || value || "未标注";
}

function normalizeTextList(value) {
  return (Array.isArray(value) ? value : (value ? [value] : []))
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function normalizeArtifact(value) {
  const item = value && typeof value === "object" ? value : {};
  return {
    artifact_id: String(item.artifact_id || item.id || "").trim(),
    title: String(item.title || item.name || item.path || "").trim(),
    path: String(item.path || "").trim(),
    url: String(item.url || item.uri || "").trim(),
    sha256: String(item.sha256 || "").trim()
  };
}

function formatArtifactLine(artifact) {
  const label = artifact.title || artifact.artifact_id || "Artifact";
  const location = artifact.url ? `：${artifact.url}` : artifact.path ? `：${artifact.path}` : "";
  const identity = artifact.artifact_id ? `（Artifact ID: ${artifact.artifact_id}）` : "";
  return `- ${label}${identity}${location}`;
}

function formatAuditEntry(entry) {
  const labels = {
    created: "任务创建",
    dispatched: `派发给 ${entry.target_agent_id || "目标 Agent"}`,
    input_artifacts_attached: "输入材料已绑定",
    result_received: "收到 Task Result",
    result_accepted: "Task Result 验收完成",
    completed: "Hermes 验收完成",
    expired: "任务到期",
    expired_by_collection_deadline: "收集截止，到期关闭",
    review_expired_no_objection: "Review 到期，未提出异议"
  };
  return `- ${entry.at || "未知时间"} · ${labels[entry.type] || entry.type || "状态更新"}${entry.summary ? `：${entry.summary}` : ""}`;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}
