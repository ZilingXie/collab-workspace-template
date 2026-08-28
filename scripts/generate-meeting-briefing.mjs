#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildMemoryContext } from "./memory-context.mjs";
import { recordMemoryUsage } from "./memory-usage.mjs";
import { getWorkspaceRoot, readJson, writeJsonAtomic } from "./card-v1-lib.mjs";

const scriptDirectory = path.dirname(new URL(import.meta.url).pathname);
const workspaceRoot = getWorkspaceRoot(scriptDirectory);
const participants = argument("--participants").split(",").map((value) => value.trim()).filter(Boolean);
const topicId = argument("--topic-id");
const outputPathArg = argument("--output");
const briefingIdArg = argument("--briefing-id");
const requester = argument("--requester") || "Zac";
const now = new Date().toISOString();
const index = await readJson(path.join(workspaceRoot, "08-cards", "card_index.json"), {});
const taskIndex = await readJson(path.join(workspaceRoot, "09-tasks", "task_index.json"), {});
const people = participants.length ? participants : ["Zac", "Vivi"];
const context = await buildMemoryContext({
  workspaceRoot,
  action: "meeting_briefing",
  requester,
  participants: people,
  topicId
});

const events = (index.human_events || [])
  .filter((event) => event.status !== "superseded" && (!topicId || (event.topic_ids || []).includes(topicId)))
  .sort((a, b) => String(b.occurred_at || b.updated_at).localeCompare(String(a.occurred_at || a.updated_at)));
const topics = (index.topics || [])
  .filter((topic) => topic.status !== "superseded" && (!topicId || topic.topic_id === topicId))
  .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
const tasks = await loadTaskResults(index.tasks || taskIndex.tasks || []);
const progressTasks = tasks.filter(isProjectProgressTask);
const activeTasks = progressTasks.filter((task) => !["completed", "completed_before_dispatch", "expired", "cancelled", "superseded"].includes(task.status));
const recentCards = (index.cards || []).filter((card) => card.lifecycle_status === "accepted");
const progress = people.map((person) => participantProgress(person, recentCards, progressTasks, topics, events));
const suggestions = buildSuggestedTopics({ topics, tasks, activeTasks, events, progress });
const memoryApplication = buildMemoryApplication(context, { events, activeTasks });
const currentProgress = buildCurrentProgress(events, topics, activeTasks, memoryApplication);
const sourceRefs = unique([
  "08-cards/card_index.json",
  "09-tasks/task_index.json",
  "07-state/PROJECT_STATE.md",
  ...context.memory.map((item) => item.path),
  ...suggestions.flatMap((item) => item.source_refs || [])
]);
const briefing = {
  schema_version: 1,
  briefing_id: briefingIdArg || `briefing-${now.replace(/[^0-9]/g, "").slice(0, 14)}`,
  created_at: now,
  requester,
  participants: people,
  current_progress: currentProgress,
  participant_progress: progress,
  suggested_topics: suggestions,
  memory_usage_id: context.usage_id,
  memory_refs: context.memory_refs,
  memory_application: memoryApplication,
  source_refs: sourceRefs,
  required_sections: ["当前进度", "参与者进度", "建议主题"],
  missing_information: unique([
    ...(context.missing_information || []),
    ...(suggestions.length ? [] : ["当前动态索引和 accepted Task Result 中没有足够证据提出可靠的会议议题。"])
  ])
};
const markdown = renderMarkdown(briefing);
const outputPath = outputPathArg
  ? path.resolve(workspaceRoot, outputPathArg)
  : path.join(workspaceRoot, "05-agent-outputs", "project-hermes", "meeting-briefings", `${briefing.briefing_id}.md`);
const relativeMarkdownPath = path.relative(workspaceRoot, outputPath).split(path.sep).join("/");
const markdownSha256 = createHash("sha256").update(markdown, "utf8").digest("hex");
briefing.markdown_path = relativeMarkdownPath;
briefing.markdown_url = `${String(process.env.COLLAB_PUBLIC_BASE_URL || "").replace(/\/+$/, "")}/collaborate/${relativeMarkdownPath}`;
briefing.sha256 = markdownSha256;
briefing.chat_text_sha256 = markdownSha256;
briefing.persisted_before_delivery = true;
await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o2775 });
await fs.writeFile(outputPath, markdown, { mode: 0o664 });
await writeJsonAtomic(outputPath.replace(/\.md$/i, ".json"), briefing);
await recordMemoryUsage(workspaceRoot, {
  usage_id: context.usage_id,
  action: context.action,
  requester,
  participants: people,
  memory_ids: context.memory_refs,
  memory_paths: context.memory.map((item) => item.path),
  dynamic_refs: sourceRefs.filter((ref) => !ref.startsWith("10-memory/")),
  outcome_ref: path.relative(workspaceRoot, outputPath).split(path.sep).join("/")
});
console.log(JSON.stringify({ ok: true, output: relativeMarkdownPath, briefing_id: briefing.briefing_id, memory_usage_id: context.usage_id, suggested_topic_count: suggestions.length, sha256: markdownSha256, persisted_before_delivery: true }, null, 2));

function participantProgress(person, cards, allTasks, allTopics, allEvents) {
  const normalized = normalizePerson(person);
  const personCards = cards.filter((card) => normalizePerson(card.author) === normalized).sort(byDateDesc);
  const personTasks = allTasks.filter((task) => normalizePerson(task.owner) === normalized || normalizePerson(task.assignee) === normalized).sort(byDateDesc);
  const completed = personTasks.filter((task) => ["completed", "completed_before_dispatch"].includes(task.status));
  const active = personTasks.filter((task) => !["completed", "completed_before_dispatch", "expired", "cancelled", "superseded"].includes(task.status));
  const relatedTopics = allTopics.filter((topic) => topic.topic_kind !== "briefing" && (topic.personal_card_ids || []).some((id) => personCards.some((card) => card.card_id === id)));
  return {
    person,
    recently_completed: unique([
      ...completed.slice(0, 2).flatMap((task) => cleanSummaryPoints(task._latest_result?.summary_points?.length
        ? task._latest_result.summary_points
        : [task.completion_summary || task.title])),
      ...personCards.slice(0, 1).flatMap((card) => cleanSummaryPoints(card.key_points || []).slice(0, 2))
    ]).slice(0, 3),
    current: unique([
      ...active.slice(0, 3).map(formatActiveTask),
      ...relatedTopics.slice(0, 2).map((topic) => topic.title)
    ]).slice(0, 3),
    pending_confirmation: unique([
      ...personTasks.filter((task) => task.status === "need_review").map((task) => task.title),
      ...allEvents.filter((event) => (event.participants || []).map(normalizePerson).includes(normalized) && event.status === "need_review").map((event) => event.title)
    ]).slice(0, 3),
    source_refs: unique([...personCards.slice(0, 3).map((card) => card.card_path), ...personTasks.slice(0, 3).map((task) => task.task_path)])
  };
}

function buildCurrentProgress(events, topics, tasks, memoryApplication) {
  const latest = events[0];
  const activeTopics = topics.filter((topic) => topic.status === "active" && topic.topic_kind !== "briefing");
  const activeTaskLabels = tasks.slice(0, 4).map(formatActiveTask);
  const historicalSummary = latest?.summary || latest?.title || "暂无可确认的最新 Human Event 总结。";
  const warnings = [];
  if (tasks.length && /(?:不创建|没有|无)[^。\\n]{0,20}(?:正式\\s*)?Task/i.test(historicalSummary)) {
    warnings.push("历史 Human Event 曾记录暂无正式 Task，但实时 Task 索引显示当前仍有进行中的 Task；本次以实时索引为准。");
  }
  const applied = memoryApplication.filter((item) => item.status === "applied");
  const summary = tasks.length
    ? `实时索引显示 ${tasks.length} 个进行中的项目 Task${activeTaskLabels.length ? `：${activeTaskLabels.join("、")}` : ""}。${latest ? `最近 Human Event（${latest.occurred_at || "时间未知"}）作为历史背景：${historicalSummary}` : ""}`
    : historicalSummary;
  return {
    summary,
    recent_human_event: latest ? { human_event_id: latest.human_event_id, title: latest.title, occurred_at: latest.occurred_at } : null,
    historical_context: latest ? historicalSummary : null,
    active_topics: activeTopics.slice(0, 6).map((topic) => ({ topic_id: topic.topic_id, topic_kind: topic.topic_kind || null, title: topic.title, summary: topic.current_summary || topic.summary || "" })),
    active_tasks: tasks.slice(0, 6).map((task) => ({ task_id: task.task_id, title: task.title, status: task.status, stale: isStaleTask(task) })),
    task_counts: Object.fromEntries([...new Set(tasks.map((task) => task.status || "unknown"))].map((status) => [status, tasks.filter((task) => task.status === status).length])),
    warnings: unique(warnings.concat(applied.length ? [] : ["本次未观察到 Memory 对 Briefing 内容产生可证明影响。"]))
  };
}

function buildMemoryApplication(context, { events, activeTasks }) {
  return context.memory.map((item) => {
    const identity = `${item.memory_id} ${item.path} ${item.content || ""}`;
    if (/pdca-4-stale-project-state|动态索引与项目状态不同步|实时索引为准/.test(identity)) {
      return {
        memory_ref: item.path,
        status: "applied",
        used_for: "将实时 Task/Card/Topic 索引置于历史 PROJECT_STATE 和 Human Event 摘要之前。",
        affected_sections: ["current_progress"],
        affected_claim_ids: ["progress-current-task-state"],
        effect: activeTasks.length
          ? `识别到 ${activeTasks.length} 个实时进行中的 Task，并将历史状态降级为背景。`
          : "校验实时索引优先规则；当前没有可确认的进行中 Task。"
      };
    }
    return {
      memory_ref: item.path,
      status: "read_not_applied",
      used_for: "已读取为会议 Briefing 的受限上下文；本次生成未记录可证明的直接因果影响。",
      affected_sections: []
    };
  });
}

function buildSuggestedTopics({ topics, tasks, activeTasks, events, progress }) {
  const suggestions = [];
  for (const task of tasks.filter((item) => item._latest_result?.acceptance_status === "accepted").sort(byDateDesc)) {
    for (const title of extractSuggestedTopicTitles(task._latest_result.submitted_text || "")) {
      suggestions.push({
        question: title,
        reason: `accepted Task Result 明确建议把“${title}”作为后续会议议题。`,
        expected_result: "围绕该议题形成明确结论，并决定是否需要创建后续执行 Task。",
        source_refs: unique([task.latest_result_path, task.latest_result_markdown_path, task.task_path])
      });
      if (suggestions.length >= 2) return suggestions;
    }
  }
  const needsReview = activeTasks.filter((task) => task.status === "need_review");
  if (needsReview.length) suggestions.push({
    question: `如何处理当前 ${needsReview.length} 个待审核事项：${needsReview.slice(0, 2).map((task) => task.title).join("、")}？`,
    reason: "项目中存在尚未完成 Manager Review 的事项。",
    expected_result: "确定每个事项的 approved、rejected 或继续 need_review 状态。",
    source_refs: needsReview.slice(0, 3).map((task) => task.task_path)
  });
  for (const topic of topics.filter((item) => item.status === "active" && item.topic_kind !== "briefing")) {
    if (suggestions.length >= 2) break;
    suggestions.push({
      question: topic.title,
      reason: topic.current_summary || topic.summary || "该项目议题仍处于 active 状态。",
      expected_result: "确认当前未对齐点，并确定本次会议要形成的结论或下一步。",
      source_refs: unique([topic.topic_path, ...events.slice(0, 2).map((event) => event.event_path).filter(Boolean)])
    });
  }
  if (!suggestions.length && progress.some((item) => item.pending_confirmation.length)) suggestions.push({
    question: "根据当前最大未对齐点和项目进度，本次会议首先需要解决哪个确认问题？",
    reason: "参与者进度中存在待确认内容。",
    expected_result: "选定一个明确问题和下一步。",
    source_refs: progress.flatMap((item) => item.source_refs).slice(0, 4)
  });
  return suggestions.slice(0, 2);
}

async function loadTaskResults(allTasks) {
  return Promise.all(allTasks.map(async (task) => {
    const resultPath = String(task.latest_result_path || "").trim();
    if (!resultPath) return task.result_summary_points?.length
      ? { ...task, _latest_result: { acceptance_status: "accepted", summary_points: task.result_summary_points, submitted_text: "" } }
      : task;
    const absolute = path.resolve(workspaceRoot, resultPath);
    if (!absolute.startsWith(`${workspaceRoot}${path.sep}`)) return task;
    const result = await readJson(absolute, null);
    return result ? { ...task, _latest_result: result } : task;
  }));
}

function isProjectProgressTask(task) {
  if (["daily_action", "card_submission", "fanout_collection", "fanout_decomposition", "manager_review", "briefing_review", "human_event_review", "card_collection"].includes(task.task_kind)) return false;
  if (task.workflow_kind && ["briefing_review", "human_event_review", "card_collection"].includes(task.workflow_kind)) return false;
  if ((task.input_artifacts || []).some((artifact) => artifact.kind === "meeting_briefing")) return false;
  if (task.task_kind === "daily_action" && task.action === "NO_TASK") return false;
  if (task.action === "NO_TASK" || task.dispatch_kind === "reminder") return false;
  if (/(?:briefing review|manager review|card collection|no_task notification)/i.test(String(task.title || ""))) return false;
  return true;
}

function formatActiveTask(task) {
  const due = Date.parse(task.due_at || task.due_date || "");
  const updated = Date.parse(task.updated_at || task.created_at || "");
  const stale = (Number.isFinite(due) && due < Date.now()) || (Number.isFinite(updated) && Date.now() - updated > 14 * 24 * 60 * 60 * 1000);
  return `${task.title}（${task.status}${stale ? "，状态可能过期" : ""}）`;
}

function isStaleTask(task) {
  const due = Date.parse(task.due_at || task.due_date || "");
  const updated = Date.parse(task.updated_at || task.created_at || "");
  return (Number.isFinite(due) && due < Date.now()) || (Number.isFinite(updated) && Date.now() - updated > 14 * 24 * 60 * 60 * 1000);
}

function cleanSummaryPoints(values) {
  return values
    .map((value) => String(value || "").trim())
    .filter((value) => value && !/(?:review\.json\s+status|briefing review workflow|manager review|no_task notification|已有项目产物满足完成标准)/i.test(value));
}

function extractSuggestedTopicTitles(text) {
  const titles = [];
  for (const match of String(text).matchAll(/(?:^|\n)\s*标题[：:]\s*(?:\n\s*)?([^\n]+)/g)) {
    const title = match[1].replace(/^[-*#\s]+/, "").trim();
    if (title && title.length <= 120) titles.push(title);
  }
  return unique(titles).slice(0, 2);
}

function renderMarkdown(input) {
  const lines = ["---", `briefing_id: ${input.briefing_id}`, `created_at: ${input.created_at}`, "type: meeting_briefing", `memory_usage_id: ${input.memory_usage_id}`, "source_refs:", ...input.source_refs.map((ref) => `  - ${ref}`), "---", "", "# 会议前 Briefing", "", "## 当前进度", `- ${input.current_progress.summary}`];
  if (input.current_progress.active_topics.length) {
    lines.push("", "当前活跃 Topic：", ...input.current_progress.active_topics.map((topic) => `- ${topic.title}${topic.summary ? `：${topic.summary}` : ""}`));
  }
  if (input.current_progress.warnings?.length) {
    lines.push("", "状态说明：", ...input.current_progress.warnings.map((warning) => `- ${warning}`));
  }
  const appliedMemory = input.memory_application.filter((item) => item.status === "applied");
  lines.push("", "Memory 应用：", ...(appliedMemory.length
    ? appliedMemory.map((item) => `- ${item.used_for}${item.effect ? `（${item.effect}）` : ""}`)
    : ["- 本次未观察到 Memory 对 Briefing 内容产生可证明影响。"]));
  lines.push("", "## 参与者进度");
  for (const item of input.participant_progress) {
    lines.push("", `### ${item.person}`, "", "最近完成：", ...(item.recently_completed.length ? item.recently_completed.map((value) => `- ${value}`) : ["- 暂无可确认记录。"]), "", "当前推进：", ...(item.current.length ? item.current.map((value) => `- ${value}`) : ["- 暂无可确认记录。"]), "", "待确认或阻塞：", ...(item.pending_confirmation.length ? item.pending_confirmation.map((value) => `- ${value}`) : ["- 暂无可确认记录。"]));
  }
  lines.push("", "## 建议主题");
  if (input.suggested_topics.length) input.suggested_topics.forEach((item, index) => lines.push("", `${index + 1}. ${item.question}`, `   - 原因：${item.reason}`, `   - 期望结果：${item.expected_result}`));
  else lines.push("", "- 当前没有足够证据提出新的会议主题。");
  if (input.missing_information.length) lines.push("", "## 信息缺口", ...input.missing_information.map((item) => `- ${item}`));
  return lines.join("\n") + "\n";
}

function byDateDesc(left, right) { return String(right.updated_at || right.submitted_at || right.occurred_at || "").localeCompare(String(left.updated_at || left.submitted_at || left.occurred_at || "")); }
function normalizePerson(value) { const text = String(value || "").toLowerCase(); if (text.includes("vivi")) return "vivi"; if (text.includes("zac")) return "zac"; return text.trim(); }
function unique(values) { return [...new Set(values.filter((value) => value !== null && value !== undefined && String(value).trim()).map((value) => String(value).trim()))]; }
function argument(name) { const index = process.argv.indexOf(name); return index >= 0 ? String(process.argv[index + 1] || "") : ""; }
