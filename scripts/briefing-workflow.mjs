#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  appendJsonLine,
  getWorkspaceRoot,
  parseFrontmatter,
  randomId,
  readJson,
  relativePath,
  unique,
  walkFiles,
  writeJsonAtomic
} from "./card-v1-lib.mjs";
import { createFanoutCollection, reconcileFanoutCollections } from "./fanout-collection.mjs";
import { listProjectTasks, renderTaskIndex, taskRegistryPaths } from "./task-registry.mjs";
import { loadLatestTaskResult, normalizeResultEnvelope } from "./task-result.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = getWorkspaceRoot(scriptDirectory);
const briefingRootName = path.join("05-agent-outputs", "project-hermes", "meeting-briefings");
const defaultParticipants = ["Zac", "Vivi"];
const terminalTaskStatuses = new Set(["completed", "completed_before_dispatch", "expired", "cancelled", "superseded"]);

export async function createReviewedBriefing(workspaceRoot, input = {}) {
  const existing = await findBriefingByRequestId(workspaceRoot, input.request_message_id);
  if (existing) {
    await refreshIndexes(workspaceRoot);
    await assertBriefingProjection(workspaceRoot, existing);
    return { ok: true, deduplicated: true, mode: existing.generation_mode, briefing: existing };
  }

  const context = await createBriefingContext(workspaceRoot, input, "reviewed");
  const generated = await generateBriefing(workspaceRoot, context, context.draft_path);
  let metadata = await finalizeMetadata(workspaceRoot, context, {
    ...generatedBriefingFields(generated),
    status: "draft",
    draft_path: context.draft_path,
    final_path: null,
    draft_card_id: null,
    final_card_id: null
  });

  const draftCardId = await writeBriefingPersonalCard(workspaceRoot, metadata, context.draft_path);
  metadata.draft_card_id = draftCardId;
  await writeBriefingMetadata(workspaceRoot, metadata);
  await updateBriefingTopic(workspaceRoot, metadata, {
    personal_card_ids: [draftCardId],
    briefing_status: "draft"
  });

  const deadline = input.due_at || new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const fanout = await createFanoutCollection(workspaceRoot, {
    title: `收集参会成员对${context.title}的反馈`,
    content: `请评审 ${metadata.briefing_id} 的初版会前简报，确认当前进度、参会人进度、建议议题和会议准备重点。`,
    topic_id: metadata.topic_id,
    origin_ref: `briefing:${metadata.briefing_id}`,
    dedupe_key: `briefing:${metadata.briefing_id}:review`,
    workflow_kind: "briefing_review",
    assignees: normalizeParticipants(context.participants).map((person) => ({
      name: person.name,
      agent_id: person.agent_id,
      title: `${person.name} 对${context.title}的反馈`,
      content: `请阅读初版会前简报 ${metadata.briefing_id}，提交确认、修改或补充意见。`,
      done_criteria: "提交可追溯的 Briefing 评审反馈；可以是文件 Artifact，也可以是完整文本回复。",
      risk_level: "L1"
    })),
    source_refs: unique([metadata.markdown_path, metadata.json_path, ...(metadata.source_refs || [])]),
    input_artifacts: [briefingArtifact(metadata)],
    child_done_criteria: "参会成员提交对同一份初版 Briefing 的评审反馈。",
    due_at: deadline,
    human_event_ids: []
  });

  metadata = await readBriefingMetadata(workspaceRoot, metadata.briefing_id);
  metadata.status = "review_collecting";
  metadata.review_parent_task_id = fanout.parent.task_id;
  metadata.review_task_ids = fanout.children.map((task) => task.task_id);
  metadata.review_deadline_at = deadline;
  metadata.review_coverage = { total: fanout.children.length, completed: 0, missing: fanout.children.map((task) => task.owner) };
  await writeBriefingMetadata(workspaceRoot, metadata);
  await updateBriefingTopic(workspaceRoot, metadata, {
    task_ids: [fanout.parent.task_id, ...(fanout.decomposition ? [fanout.decomposition.task_id] : []), ...fanout.children.map((task) => task.task_id)],
    briefing_status: "review_collecting"
  });
  await refreshIndexes(workspaceRoot);
  await assertBriefingProjection(workspaceRoot, metadata);
  return { ok: true, created: true, mode: "reviewed", briefing: metadata, fanout };
}

export async function createDirectBriefing(workspaceRoot, input = {}) {
  const existing = await findBriefingByRequestId(workspaceRoot, input.request_message_id);
  if (existing) {
    await refreshIndexes(workspaceRoot);
    await assertBriefingProjection(workspaceRoot, existing);
    return { ok: true, deduplicated: true, mode: existing.generation_mode, briefing: existing };
  }

  const context = await createBriefingContext(workspaceRoot, input, "direct");
  const generated = await generateBriefing(workspaceRoot, context, context.final_path);
  let metadata = await finalizeMetadata(workspaceRoot, context, {
    ...generatedBriefingFields(generated),
    status: "finalized_direct",
    draft_path: null,
    final_path: context.final_path,
    draft_card_id: null,
    final_card_id: null,
    final_sha256: generated.sha256,
    review_status: "skipped_by_explicit_request",
    review_coverage: { total: 0, completed: 0, missing: [], mode: "direct" }
  });
  metadata.summary_points = briefingSummaryPoints(metadata);
  await writeBriefingMetadata(workspaceRoot, metadata);
  const summary = metadata.summary_points[0] || "已生成最终会前简报，可按此准备会议。";
  await updateBriefingTopic(workspaceRoot, metadata, {
    briefing_status: "finalized_direct",
    briefing_summary_points: metadata.summary_points,
    current_summary: summary,
    key_points: metadata.summary_points.length ? metadata.summary_points : [summary],
    final_briefing_path: metadata.final_path,
    final_briefing_url: metadata.final_url
  });
  await refreshIndexes(workspaceRoot);
  await assertBriefingProjection(workspaceRoot, metadata);
  return { ok: true, created: true, mode: "direct", briefing: metadata };
}

export async function captureBriefingReviewSnapshot(workspaceRoot, taskId, resultInput, relayTaskId = "") {
  const metadata = await findBriefingForTask(workspaceRoot, taskId);
  if (!metadata) return { ok: false, ignored: true, reason: "briefing_not_found" };
  const task = await readJson(path.join(taskRegistryPaths(workspaceRoot).taskRecordsRoot, taskId, "task.json"), null);
  if (!task) return { ok: false, ignored: true, reason: "task_not_found" };
  const reviewer = task.owner || task.owner_agent_id || "未标注参会人";
  const reviewRoot = path.join(workspaceRoot, briefingRootName, "reviews", metadata.briefing_id);
  await fs.mkdir(reviewRoot, { recursive: true, mode: 0o2775 });
  const safeReviewer = String(reviewer).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || taskId;
  const result = typeof resultInput === "object" && resultInput
    ? normalizeResultEnvelope(resultInput)
    : (await loadLatestTaskResult(workspaceRoot, task)) || normalizeResultEnvelope({ submitted_text: resultInput });
  const reviewText = result.submitted_text || result.summary || "未提供文本评审结果。";
  const snapshot = {
    schema_version: 2,
    briefing_id: metadata.briefing_id,
    task_id: taskId,
    relay_task_id: relayTaskId || task.relay_task_id || null,
    reviewer,
    status: "accepted",
    result_id: result.result_id || task.latest_result_id || null,
    has_feedback: Boolean(result.submitted_text || result.artifact_refs?.length),
    response_sha256: result.source_hash || sha256(reviewText),
    response_path: `${briefingRootName}/reviews/${metadata.briefing_id}/${safeReviewer}.md`,
    task_result_path: result.full_text_path || task.latest_result_path || null,
    summary_points: result.summary_points || [],
    artifact_refs: result.artifact_refs || [],
    verification: result.verification || [],
    blockers: result.blockers || [],
    completed_at: task.completed_at || new Date().toISOString(),
    source_refs: unique([task.task_path, task.audit_path, ...(task.source_refs || [])])
  };
  await fs.writeFile(path.join(reviewRoot, `${safeReviewer}.md`), `# ${reviewer} Briefing 评审\n\n${reviewText}\n`, { mode: 0o664 });
  await writeJsonAtomic(path.join(reviewRoot, `${safeReviewer}.json`), snapshot);
  metadata.review_snapshots = unique([...(metadata.review_snapshots || []), snapshot.response_path]);
  await writeBriefingMetadata(workspaceRoot, metadata);
  return { ok: true, snapshot };
}

export async function reconcileBriefing(workspaceRoot, options = {}) {
  const metadata = options.briefing_id
    ? await readBriefingMetadata(workspaceRoot, options.briefing_id)
    : await findBriefingForTask(workspaceRoot, options.child_task_id || options.parent_task_id || "");
  if (!metadata || metadata.generation_mode !== "reviewed" || !metadata.review_parent_task_id) {
    return { ok: true, ignored: true, reason: "not_a_reviewed_briefing" };
  }
  if (["finalized_full", "finalized_partial", "finalized_no_response"].includes(metadata.status)) {
    return { ok: true, already_finalized: true, briefing: metadata };
  }

  const tasks = await listProjectTasks(workspaceRoot);
  const children = tasks.filter((task) => (metadata.review_task_ids || []).includes(task.task_id));
  const allCompleted = children.length > 0 && children.every((task) => ["completed", "completed_before_dispatch"].includes(task.status));
  const deadlinePassed = Boolean(options.force || (metadata.review_deadline_at && Date.parse(metadata.review_deadline_at) <= Date.now()));
  if (!allCompleted && !deadlinePassed) {
    await updateReviewCoverage(workspaceRoot, metadata, children);
    return { ok: true, waiting: true, briefing: await readBriefingMetadata(workspaceRoot, metadata.briefing_id) };
  }

  if (deadlinePassed && !allCompleted) {
    await reconcileFanoutCollections(workspaceRoot, { parentTaskId: metadata.review_parent_task_id, force: true });
  } else if (allCompleted) {
    await completeBriefingParent(workspaceRoot, metadata.review_parent_task_id, children);
    await reconcileFanoutCollections(workspaceRoot, { parentTaskId: metadata.review_parent_task_id });
  }

  const finalTasks = await listProjectTasks(workspaceRoot);
  const finalChildren = finalTasks.filter((task) => (metadata.review_task_ids || []).includes(task.task_id));
  const outcome = finalChildren.every((task) => ["completed", "completed_before_dispatch"].includes(task.status))
    ? "finalized_full"
    : finalChildren.some((task) => ["completed", "completed_before_dispatch"].includes(task.status))
      ? "finalized_partial"
      : "finalized_no_response";
  const finalized = await writeFinalBriefing(workspaceRoot, metadata, finalChildren, outcome);
  await refreshIndexes(workspaceRoot);
  return { ok: true, finalized: true, briefing: finalized };
}

async function createBriefingContext(workspaceRoot, input, mode) {
  const participants = normalizeParticipants(input.participants || defaultParticipants);
  if (!participants.length) throw new Error("Briefing requires at least one mapped human participant");
  const now = new Date().toISOString();
  const briefingId = input.briefing_id || randomId("briefing-", 8);
  const topicId = input.topic_id || randomId("topic-", 8);
  const title = input.title || `${input.meeting_date || now.slice(0, 10)} ${participants.map((person) => person.name).join(" / ")} 会议 Briefing`;
  const topic = {
    schema_version: 1,
    topic_id: topicId,
    topic_kind: "briefing",
    title,
    current_summary: input.meeting_goal || "用于准备一次临时会议的会前简报。",
    key_points: [input.meeting_goal || "用于准备一次临时会议的会前简报。"],
    human_event_ids: [],
    personal_card_ids: [],
    task_ids: [],
    briefing_ids: [briefingId],
    source_refs: [],
    status: "active",
    briefing_status: mode === "direct" ? "generating" : "draft",
    created_at: now,
    updated_at: now
  };
  const topicPath = path.join(workspaceRoot, "08-cards", "topics", topicId, "topic.json");
  await fs.mkdir(path.dirname(topicPath), { recursive: true, mode: 0o2775 });
  await writeJsonAtomic(topicPath, topic);
  const briefingDir = path.join(workspaceRoot, briefingRootName);
  await fs.mkdir(briefingDir, { recursive: true, mode: 0o2775 });
  const draftPath = relativePath(workspaceRoot, path.join(briefingDir, `${briefingId}.md`));
  const finalPath = relativePath(workspaceRoot, path.join(briefingDir, `${briefingId}-final.md`));
  const metadata = {
    schema_version: 2,
    briefing_id: briefingId,
    topic_id: topicId,
    title,
    meeting_date: input.meeting_date || now.slice(0, 10),
    meeting_goal: input.meeting_goal || "",
    participants: participants.map((person) => person.name),
    participant_agents: Object.fromEntries(participants.map((person) => [person.name, person.agent_id])),
    requester: input.requester || "Zac",
    request_message_id: input.request_message_id || null,
    generation_mode: mode,
    status: mode === "direct" ? "generating" : "draft",
    draft_path: mode === "direct" ? null : draftPath,
    final_path: mode === "direct" ? finalPath : null,
    source_refs: ["08-cards/card_index.json", "09-tasks/task_index.json", "07-state/PROJECT_STATE.md"],
    created_at: now,
    updated_at: now
  };
  await writeJsonAtomic(path.join(briefingDir, `${briefingId}.json`), metadata);
  return { ...metadata, participants, draft_path: draftPath, final_path: finalPath };
}

async function generateBriefing(workspaceRoot, context, outputPath) {
  const workspaceScriptPath = path.join(workspaceRoot, "scripts", "generate-meeting-briefing.mjs");
  const scriptPath = await exists(workspaceScriptPath) ? workspaceScriptPath : path.join(scriptDirectory, "generate-meeting-briefing.mjs");
  const result = await runNode(scriptPath, [
    "--participants", context.participants.map((person) => person.name).join(","),
    "--requester", context.requester,
    "--briefing-id", context.briefing_id,
    "--output", outputPath
  ], workspaceRoot);
  if (result.code !== 0) throw new Error(result.stderr || "Briefing generation failed");
  const metadataPath = path.join(workspaceRoot, briefingRootName, `${context.briefing_id}.json`);
  if (!(await exists(path.join(workspaceRoot, outputPath))) || !(await exists(metadataPath))) {
    throw new Error("Briefing generator did not persist MD and JSON");
  }
  const generatedSidecar = path.join(workspaceRoot, outputPath).replace(/\.md$/i, ".json");
  const generatedMetadata = await readJson(generatedSidecar, null);
  if (generatedSidecar !== metadataPath) await fs.rm(generatedSidecar, { force: true });
  return generatedMetadata;
}

async function finalizeMetadata(workspaceRoot, context, fields) {
  const metadata = await readBriefingMetadata(workspaceRoot, context.briefing_id);
  const markdownPath = fields.final_path || fields.draft_path;
  const text = await fs.readFile(path.join(workspaceRoot, markdownPath), "utf8");
  const relativeJsonPath = path.join(briefingRootName, `${context.briefing_id}.json`).split(path.sep).join("/");
  const result = {
    ...context,
    ...metadata,
    ...fields,
    // The generator writes a schema-v1 sidecar at the same path. Preserve the
    // workflow envelope as the authoritative schema after merging its output.
    schema_version: 2,
    topic_id: context.topic_id,
    generation_mode: context.generation_mode,
    markdown_path: fields.final_path || fields.draft_path,
    markdown_url: publicUrl(fields.final_path || fields.draft_path),
    json_path: relativeJsonPath,
    sha256: sha256(text),
    chat_text_sha256: sha256(text),
    persisted_before_delivery: true,
    updated_at: new Date().toISOString()
  };
  if (fields.final_path) result.final_url = publicUrl(fields.final_path);
  return result;
}

async function writeBriefingMetadata(workspaceRoot, metadata) {
  metadata.updated_at = new Date().toISOString();
  await writeJsonAtomic(path.join(workspaceRoot, briefingRootName, `${metadata.briefing_id}.json`), metadata);
}

async function writeBriefingPersonalCard(workspaceRoot, metadata, draftPath) {
  const cardId = randomId("", 8);
  const text = await fs.readFile(path.join(workspaceRoot, draftPath), "utf8");
  const body = parseFrontmatter(text).body.trim();
  const sourceRefs = unique([draftPath, metadata.json_path || `${briefingRootName}/${metadata.briefing_id}.json`]);
  const cardLines = [
    "---", `card_id: ${cardId}`, `content_id: ${cardId}`, `topic_id: ${metadata.topic_id}`,
    "placement_type: topic", `placement_id: ${metadata.topic_id}`, "card_type: personal", "author: Hermes",
    `briefing_id: ${metadata.briefing_id}`, "briefing_stage: draft", `occurred_at: ${metadata.created_at}`,
    `submitted_at: ${metadata.created_at}`, `title: ${JSON.stringify(`初版会前简报：${metadata.title}`)}`,
    "participants:", ...metadata.participants.map((person) => `  - ${person}`),
    "source_refs:", ...sourceRefs.map((ref) => `  - ${ref}`),
    "key_points:", ...briefingSummaryPoints(metadata).map((point) => `  - ${point}`),
    "---", "", body, ""
  ];
  await fs.mkdir(path.join(workspaceRoot, "08-cards", "cards"), { recursive: true, mode: 0o2775 });
  await fs.mkdir(path.join(workspaceRoot, "08-cards", "contents"), { recursive: true, mode: 0o2775 });
  await fs.writeFile(path.join(workspaceRoot, "08-cards", "cards", `card-${cardId}.md`), cardLines.join("\n"), { mode: 0o664 });
  await fs.writeFile(path.join(workspaceRoot, "08-cards", "contents", `content-${cardId}.md`), `${body}\n`, { mode: 0o664 });
  return cardId;
}

async function writeFinalBriefing(workspaceRoot, metadata, children, outcome) {
  const draftText = metadata.draft_path
    ? await fs.readFile(path.join(workspaceRoot, metadata.draft_path), "utf8")
    : "";
  const reviews = await readReviewSnapshots(workspaceRoot, metadata.briefing_id);
  const points = briefingSummaryPoints(metadata, reviews, outcome);
  const reviewLabel = outcome === "finalized_full" ? "所有参会成员已完成评审。" : outcome === "finalized_partial" ? "部分参会成员已完成评审，其余内容按到期状态保留。" : "截至截止时间没有收到有效参会成员反馈。";
  const lines = [
    "---", `briefing_id: ${metadata.briefing_id}`, `topic_id: ${metadata.topic_id}`, "type: final_meeting_briefing",
    `generation_mode: ${metadata.generation_mode}`, `finalized_at: ${new Date().toISOString()}`,
    `review_outcome: ${outcome}`, "source_refs:", ...unique([metadata.draft_path, metadata.json_path, ...children.flatMap((task) => task.source_refs || [])]).filter(Boolean).map((ref) => `  - ${ref}`),
    "---", "", "# 最终会前简报", "", "## 会议使用摘要", ...points.map((point) => `- ${point}`), "", "## 评审状态", `- ${reviewLabel}`,
    "", "## 参会成员评审", ...(reviews.length ? reviews.flatMap((review) => ["", `### ${review.reviewer}`, `- ${review.text}`]) : ["", "- 暂无可用评审文本。"]),
    "", "## 原始 Briefing", "", parseFrontmatter(draftText).body.trim() || "暂无原始 Briefing 正文。", ""
  ];
  const finalText = lines.join("\n");
  const finalPath = metadata.final_path || path.join(briefingRootName, `${metadata.briefing_id}-final.md`);
  await fs.mkdir(path.dirname(path.join(workspaceRoot, finalPath)), { recursive: true, mode: 0o2775 });
  await fs.writeFile(path.join(workspaceRoot, finalPath), finalText, { mode: 0o664 });
  const next = {
    ...metadata,
    status: outcome,
    final_path: finalPath,
    final_url: publicUrl(finalPath),
    final_sha256: sha256(finalText),
    summary_points: points,
    review_coverage: {
      total: children.length,
      completed: children.filter((task) => ["completed", "completed_before_dispatch"].includes(task.status)).length,
      missing: children.filter((task) => !["completed", "completed_before_dispatch"].includes(task.status)).map((task) => task.owner),
      outcome
    },
    finalized_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await writeBriefingMetadata(workspaceRoot, next);
  await updateBriefingTopic(workspaceRoot, next, {
    briefing_status: outcome,
    briefing_summary_points: points,
    current_summary: points[0] || "已生成最终会前简报，可按此准备会议。",
    key_points: points.length ? points : ["已生成最终会前简报，可按此准备会议。"],
    final_briefing_path: finalPath,
    final_briefing_url: next.final_url
  });
  return next;
}

async function completeBriefingParent(workspaceRoot, parentTaskId, children) {
  const taskPath = path.join(taskRegistryPaths(workspaceRoot).taskRecordsRoot, parentTaskId, "task.json");
  const parent = await readJson(taskPath, null);
  if (!parent || terminalTaskStatuses.has(parent.status)) return;
  const now = new Date().toISOString();
  parent.status = "completed";
  parent.collection_status = "full";
  parent.collection_outcome = { mode: "full", total: children.length, completed: children.map((task) => task.task_id), not_completed: [] };
  parent.completion_reason = "all_briefing_reviews_completed";
  parent.completed_at = now;
  parent.updated_at = now;
  await writeJsonAtomic(taskPath, parent);
  await appendJsonLine(path.join(path.dirname(taskPath), "audit.jsonl"), { at: now, type: "collection_finalized", task_id: parentTaskId, status: parent.status, collection_status: "full", completion_reason: parent.completion_reason });
  const queuePath = taskRegistryPaths(workspaceRoot).queuePath;
  const queue = await readJson(queuePath, []);
  const item = queue.find((entry) => entry.local_task_id === parentTaskId);
  if (item) { item.status = "completed"; item.updated_at = now; await writeJsonAtomic(queuePath, queue); }
}

async function updateReviewCoverage(workspaceRoot, metadata, children) {
  metadata.review_coverage = {
    total: children.length,
    completed: children.filter((task) => ["completed", "completed_before_dispatch"].includes(task.status)).length,
    missing: children.filter((task) => !["completed", "completed_before_dispatch"].includes(task.status)).map((task) => task.owner)
  };
  await writeBriefingMetadata(workspaceRoot, metadata);
}

async function readReviewSnapshots(workspaceRoot, briefingId) {
  const root = path.join(workspaceRoot, briefingRootName, "reviews", briefingId);
  const files = await walkFiles(root, (filePath) => filePath.endsWith(".json"));
  const reviews = [];
  for (const filePath of files) {
    const snapshot = await readJson(filePath, null);
    if (!snapshot) continue;
    const textPath = filePath.replace(/\.json$/, ".md");
    let text = "";
    try { text = (await fs.readFile(textPath, "utf8")).replace(/^# .*?\n\n/, "").trim(); } catch {}
    reviews.push({ ...snapshot, text });
  }
  return reviews.sort((a, b) => String(a.reviewer).localeCompare(String(b.reviewer)));
}

async function updateBriefingTopic(workspaceRoot, metadata, fields = {}) {
  const topicPath = path.join(workspaceRoot, "08-cards", "topics", metadata.topic_id, "topic.json");
  const topic = await readJson(topicPath, null);
  if (!topic) throw new Error(`Briefing Topic not found: ${metadata.topic_id}`);
  topic.briefing_ids = unique([...(topic.briefing_ids || []), metadata.briefing_id]);
  if (fields.personal_card_ids) topic.personal_card_ids = unique([...(topic.personal_card_ids || []), ...fields.personal_card_ids]);
  if (fields.task_ids) topic.task_ids = unique([...(topic.task_ids || []), ...fields.task_ids]);
  Object.assign(topic, fields);
  topic.updated_at = new Date().toISOString();
  await writeJsonAtomic(topicPath, topic);
}

async function refreshIndexes(workspaceRoot) {
  const result = await runNode(path.join(scriptDirectory, "render-card-index.mjs"), [], workspaceRoot);
  if (result.code !== 0) throw new Error(result.stderr || "Card index rendering failed");
  await renderTaskIndex(workspaceRoot);
  const workspacePublisher = path.join(workspaceRoot, "scripts", "publish-workspace.mjs");
  const publisher = await exists(workspacePublisher) ? workspacePublisher : path.join(scriptDirectory, "publish-workspace.mjs");
  const published = await runNode(publisher, ["--reason", "briefing-workflow"], workspaceRoot);
  if (published.code !== 0) throw new Error(published.stderr || "Workspace public projection failed");
}

async function assertBriefingProjection(workspaceRoot, metadata) {
  const topic = await readJson(path.join(workspaceRoot, "08-cards", "topics", metadata.topic_id, "topic.json"), null);
  if (!topic || !(topic.briefing_ids || []).includes(metadata.briefing_id)) throw new Error("Briefing Topic projection is unavailable");
  const manifest = await readJson(path.join(workspaceRoot, "public-data", "manifest.json"), null);
  const cardsPath = manifest?.datasets?.cards;
  const publicCards = cardsPath ? await readJson(path.join(workspaceRoot, cardsPath), null) : null;
  const briefing = publicCards?.briefings?.find((item) => item.briefing_id === metadata.briefing_id && item.topic_id === metadata.topic_id);
  if (!briefing || !briefing.public_markdown) throw new Error("Briefing public projection is unavailable");
}

async function findBriefingByRequestId(workspaceRoot, requestMessageId) {
  if (!requestMessageId) return null;
  for (const filePath of await walkFiles(path.join(workspaceRoot, briefingRootName), (file) => file.endsWith(".json") && !file.includes(`${path.sep}reviews${path.sep}`))) {
    const metadata = await readJson(filePath, null);
    if (metadata?.request_message_id === requestMessageId) return metadata;
  }
  return null;
}

async function findBriefingForTask(workspaceRoot, taskId) {
  if (!taskId) return null;
  for (const filePath of await walkFiles(path.join(workspaceRoot, briefingRootName), (file) => file.endsWith(".json") && !file.includes(`${path.sep}reviews${path.sep}`))) {
    const metadata = await readJson(filePath, null);
    if (metadata && [metadata.review_parent_task_id, ...(metadata.review_task_ids || [])].includes(taskId)) return metadata;
  }
  return null;
}

async function readBriefingMetadata(workspaceRoot, briefingId) {
  const metadata = await readJson(path.join(workspaceRoot, briefingRootName, `${briefingId}.json`), null);
  if (!metadata) throw new Error(`Briefing not found: ${briefingId}`);
  return metadata;
}

function briefingArtifact(metadata) {
  return {
    artifact_id: metadata.briefing_id,
    kind: "meeting_briefing",
    title: metadata.title,
    path: metadata.markdown_path,
    url: metadata.markdown_url,
    sha256: metadata.sha256,
    required: true
  };
}

function briefingSummaryPoints(metadata, reviews = [], outcome = "") {
  const points = [];
  if (metadata.current_progress?.summary) points.push(metadata.current_progress.summary);
  const suggestions = metadata.suggested_topics || [];
  if (suggestions[0]?.question) points.push(`会议重点：${suggestions[0].question}`);
  if (reviews.length) points.push(`已综合 ${reviews.length} 位参会成员的评审反馈。`);
  if (outcome === "finalized_partial") points.push("部分评审反馈未在截止时间前收到，未确认内容已明确标注。");
  if (outcome === "finalized_no_response") points.push("截止时间前未收到参会成员反馈，本简报不代表参会成员确认。");
  const result = unique(points).slice(0, 3);
  return result.length ? result : ["已生成会前简报，可在会议中直接使用。"];
}

function generatedBriefingFields(metadata) {
  if (!metadata || typeof metadata !== "object") return {};
  return {
    current_progress: metadata.current_progress,
    participant_progress: metadata.participant_progress,
    suggested_topics: metadata.suggested_topics,
    memory_usage_id: metadata.memory_usage_id,
    memory_refs: metadata.memory_refs,
    memory_application: metadata.memory_application,
    missing_information: metadata.missing_information,
    source_refs: metadata.source_refs,
    required_sections: ["当前进度", "参与者进度", "建议主题"]
  };
}

function normalizeParticipants(value) {
  const names = Array.isArray(value) ? value : defaultParticipants;
  return names.map((item) => {
    if (item && typeof item === "object") return { name: String(item.name || "").trim(), agent_id: String(item.agent_id || "").trim() };
    return { name: String(item || "").trim(), agent_id: "" };
  }).map((person) => {
    const name = person.name;
    if (person.agent_id && name) return person;
    const lower = name.toLowerCase();
    if (lower.includes("zac")) return { name: "Zac", agent_id: "zac-agent" };
    if (lower.includes("vivi")) return { name: "Vivi", agent_id: "vivi-agent" };
    return null;
  }).filter(Boolean).filter((person, index, list) => list.findIndex((item) => item.name === person.name) === index);
}

function publicUrl(relative) {
  const base = String(process.env.COLLAB_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const reference = `/collaborate/${String(relative).replace(/^\/+/, "")}`;
  return base ? `${base}${reference}` : reference;
}
function sha256(value) { return createHash("sha256").update(String(value), "utf8").digest("hex"); }
async function exists(filePath) { try { await fs.access(filePath); return true; } catch { return false; } }

function runNode(command, args, cwd) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [command, ...args], { cwd, env: { ...process.env, COLLAB_WORKSPACE: cwd }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolveRun({ code: 1, stdout, stderr: `${stderr}\n${error.message}` }));
    child.on("close", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
  });
}

async function cli() {
  const workspaceRoot = path.resolve(process.env.COLLAB_WORKSPACE || defaultWorkspaceRoot);
  const mode = argument("--mode");
  if (mode === "reviewed") {
    console.log(JSON.stringify(await createReviewedBriefing(workspaceRoot, {
      title: argument("--title"),
      meeting_date: argument("--meeting-date"),
      meeting_goal: argument("--meeting-goal"),
      participants: argument("--participants").split(",").filter(Boolean),
      requester: argument("--requester") || "Zac",
      request_message_id: argument("--request-message-id"),
      due_at: argument("--due-at")
    }), null, 2));
    return;
  }
  if (mode === "direct") {
    console.log(JSON.stringify(await createDirectBriefing(workspaceRoot, {
      title: argument("--title"),
      meeting_date: argument("--meeting-date"),
      meeting_goal: argument("--meeting-goal"),
      participants: argument("--participants").split(",").filter(Boolean),
      requester: argument("--requester") || "Zac",
      request_message_id: argument("--request-message-id")
    }), null, 2));
    return;
  }
  if (mode === "reconcile") {
    console.log(JSON.stringify(await reconcileBriefing(workspaceRoot, {
      briefing_id: argument("--briefing-id"),
      child_task_id: argument("--child-task-id"),
      parent_task_id: argument("--parent-task-id"),
      force: process.argv.includes("--expired")
    }), null, 2));
    return;
  }
  throw new Error("Usage: briefing-workflow.mjs --mode reviewed|direct|reconcile");
}

function argument(name) { const index = process.argv.indexOf(name); return index === -1 ? "" : String(process.argv[index + 1] || ""); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli();
