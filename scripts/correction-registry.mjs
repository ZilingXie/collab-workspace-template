#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import {
  appendJsonLine,
  parseFrontmatter,
  randomId,
  readJson,
  unique,
  walkFiles,
  writeJsonAtomic
} from "./card-v1-lib.mjs";
import { createMemoryRecord, renderMemoryDocument } from "./memory-registry.mjs";
import {
  createProjectTask,
  listProjectTasks,
  renderTaskIndex,
  taskRegistryPaths
} from "./task-registry.mjs";

export const CORRECTION_TOPIC_KEY = "project-governance:hermes-corrections";
export const CORRECTION_TOPIC_TITLE = "Hermes 纠错与持续改进";

export function correctionPaths(workspaceRoot) {
  return {
    topicsRoot: path.join(workspaceRoot, "08-cards", "topics"),
    cardsRoot: path.join(workspaceRoot, "08-cards", "cards"),
    taskRecordsRoot: taskRegistryPaths(workspaceRoot).taskRecordsRoot
  };
}

export async function listTopics(workspaceRoot) {
  const files = await walkFiles(correctionPaths(workspaceRoot).topicsRoot, (filePath) => path.basename(filePath) === "topic.json");
  const topics = [];
  for (const filePath of files) {
    const topic = await readJson(filePath, null);
    if (topic) topics.push({ ...topic, _path: filePath });
  }
  return topics;
}

export async function ensureCorrectionTopic(workspaceRoot, input = {}) {
  const existing = (await listTopics(workspaceRoot)).find((topic) => (
    topic.topic_kind === "correction_governance"
    || topic.topic_key === CORRECTION_TOPIC_KEY
    || topic.title === CORRECTION_TOPIC_TITLE
  ));
  if (existing) return { topic: existing, created: false };

  const topicId = input.topic_id || randomId("topic-", 8);
  const now = input.created_at || new Date().toISOString();
  const topic = {
    schema_version: 1,
    topic_id: topicId,
    topic_key: CORRECTION_TOPIC_KEY,
    topic_kind: "correction_governance",
    title: CORRECTION_TOPIC_TITLE,
    current_summary: "记录人类对 Hermes 事实、流程、理解、表达和安全行为的纠正，并通过 Task、Correction Memory 和使用审计完成闭环。",
    human_event_ids: [],
    personal_card_ids: [],
    task_ids: [],
    source_refs: [
      "10-memory/corrections/index.md",
      "06-pdca/failure-examples.md"
    ],
    status: "active",
    created_at: now,
    updated_at: now
  };
  const topicPath = path.join(correctionPaths(workspaceRoot).topicsRoot, topicId, "topic.json");
  await fs.mkdir(path.dirname(topicPath), { recursive: true, mode: 0o2775 });
  await writeJsonAtomic(topicPath, topic);
  return { topic: { ...topic, _path: topicPath }, created: true };
}

export function correctionDedupeKey(input) {
  if (input.dedupe_key) return String(input.dedupe_key);
  const normalize = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  const actionIds = [...new Set((input.applies_to_actions || []).map(normalize).filter(Boolean))].sort().join(",");
  return [
    "correction",
    normalize(input.correction_type || "process"),
    normalize(input.correct_behavior || input.title),
    actionIds,
    [...new Set((input.target_refs || []).map(normalize).filter(Boolean))].sort().join(",")
  ].join(":").slice(0, 240);
}

export async function createCorrectionTask(workspaceRoot, input) {
  const topicResult = await ensureCorrectionTopic(workspaceRoot, input);
  const topic = topicResult.topic;
  const dedupeKey = correctionDedupeKey(input);
  const existing = (await listProjectTasks(workspaceRoot)).find((task) => (
    task.task_kind === "correction" && task.dedupe_key === dedupeKey
  ));
  if (existing) {
    const linkedTopic = await linkTaskToTopic(workspaceRoot, topic, existing, input);
    return { task: existing, topic: linkedTopic, created: false, deduplicated: true };
  }

  const now = input.created_at || new Date().toISOString();
  const correctionId = input.correction_id || randomId("correction-", 8);
  const taskId = input.task_id || randomId("task-", 8);
  const taskCardId = input.task_card_id || randomId("", 8);
  const correctionType = String(input.correction_type || "process");
  const taskResult = await createProjectTask(workspaceRoot, {
    task_id: taskId,
    task_card_id: taskCardId,
    task_kind: "correction",
    task_role: "coordinator",
    manager_role: input.manager_role || null,
    review_status: input.review_status || null,
    topic_id: topic.topic_id,
    title: input.title,
    content: input.content || renderTaskContent(input),
    owner: "Project Hermes",
    target_agent_id: "project-hermes",
    status: input.status || "ready",
    due_at: input.due_at || null,
    due_date: input.due_date || input.due_at || null,
    done_criteria: input.done_criteria || "正确行为已应用、Correction Memory 已创建、验证结果已记录。",
    human_event_ids: input.human_event_ids || [],
    source_refs: input.source_refs || [],
    priority: input.priority || "medium",
    risk_level: input.risk_level || "L1",
    origin_ref: `correction:${correctionId}`,
    parent_task_id: input.parent_task_id || null,
    child_task_ids: input.child_task_ids || [],
    dedupe_key: dedupeKey,
    created_at: now
  }, { enqueue: Boolean(input.enqueue) });

  const task = {
    ...taskResult.task,
    correction_id: correctionId,
    correction_type: correctionType,
    original_behavior: input.original_behavior || "",
    correct_behavior: input.correct_behavior || input.content || "",
    applies_to_actions: unique(input.applies_to_actions || []),
    target_refs: unique(input.target_refs || []),
    verification_refs: unique(input.verification_refs || []),
    resolution_task_ids: unique(input.resolution_task_ids || []),
    correction_memory_id: input.correction_memory_id || null,
    source_refs: unique([...(taskResult.task.source_refs || []), ...(input.source_refs || [])]),
    updated_at: now
  };
  await saveTask(workspaceRoot, task);
  await appendTaskAudit(workspaceRoot, taskId, {
    at: now,
    type: "correction_created",
    correction_id: correctionId,
    correction_type: correctionType,
    topic_id: topic.topic_id,
    status: task.status
  });
  await writeCorrectionTaskCard(workspaceRoot, task);
  const linkedTopic = await linkTaskToTopic(workspaceRoot, topic, task, input);
  await renderTaskIndex(workspaceRoot);
  return { task, topic: linkedTopic, created: true, deduplicated: false };
}

export async function confirmCorrection(workspaceRoot, taskId, input = {}) {
  const task = await readTask(workspaceRoot, taskId);
  if (!task || task.task_kind !== "correction") throw new Error(`Correction task not found: ${taskId}`);
  if (task.correction_memory_id) {
    if (input.verification_refs?.length) {
      const verificationRefs = unique(input.verification_refs);
      await assertWorkspaceRefs(workspaceRoot, verificationRefs);
      await amendCorrectionMemory(workspaceRoot, task.correction_memory_id, verificationRefs);
      const updatedTask = { ...task, verification_refs: verificationRefs, updated_at: new Date().toISOString() };
      await saveTask(workspaceRoot, updatedTask);
      await writeCorrectionTaskCard(workspaceRoot, updatedTask);
      await renderTaskIndex(workspaceRoot);
      return { task: updatedTask, memory_id: task.correction_memory_id, created: false, deduplicated: true };
    }
    return { task, memory_id: task.correction_memory_id, created: false, deduplicated: true };
  }
  if (!input.source_refs?.length && !task.source_refs?.length) {
    throw new Error("Correction confirmation requires source_refs");
  }
  await assertWorkspaceRefs(workspaceRoot, input.target_refs || task.target_refs || []);
  const verificationRefs = unique(input.verification_refs || task.verification_refs || []);
  if (!verificationRefs.length) throw new Error("Correction confirmation requires verification_refs");
  await assertWorkspaceRefs(workspaceRoot, verificationRefs);

  const memoryId = input.memory_id || `correction-memory-${task.correction_id}`;
  const memory = await createMemoryRecord(workspaceRoot, {
    memory_id: memoryId,
    memory_type: "correction",
    title: input.title || task.title,
    statement: input.correct_behavior || task.correct_behavior,
    body: renderCorrectionMemoryBody(task, input),
    correction_type: input.correction_type || task.correction_type,
    original_behavior: input.original_behavior || task.original_behavior,
    correct_behavior: input.correct_behavior || task.correct_behavior,
    applies_to_actions: input.applies_to_actions || task.applies_to_actions || [],
    target_refs: input.target_refs || task.target_refs || [],
    verification_refs: verificationRefs,
    resolution_task_ids: input.resolution_task_ids || task.resolution_task_ids || [],
    task_id: task.task_id,
    task_card_id: task.task_card_id,
    fact_status: "confirmed",
    evidence_type: "human_correction",
    source_refs: unique(input.source_refs || task.source_refs || []),
    slug: input.slug || task.correction_id
  });

  const now = input.resolved_at || new Date().toISOString();
  const updatedTask = {
    ...task,
    status: "completed",
    review_status: input.review_status || "approved",
    correction_memory_id: memory.memory_id,
    resolution_task_ids: unique(input.resolution_task_ids || task.resolution_task_ids || []),
    completion_reason: "correction_applied",
    updated_at: now
  };
  await saveTask(workspaceRoot, updatedTask);
  await appendTaskAudit(workspaceRoot, taskId, {
    at: now,
    type: "correction_memory_created",
    correction_id: task.correction_id,
    correction_memory_id: memory.memory_id,
    target_refs: updatedTask.target_refs,
    status: updatedTask.status
  });
  await writeCorrectionTaskCard(workspaceRoot, updatedTask);
  await renderTaskIndex(workspaceRoot);
  return { task: updatedTask, memory_id: memory.memory_id, memory, created: true, deduplicated: false };
}

export async function closeCorrectionTask(workspaceRoot, taskId, { reason = "correction_rejected", status = "cancelled" } = {}) {
  const task = await readTask(workspaceRoot, taskId);
  if (!task || task.task_kind !== "correction") throw new Error(`Correction task not found: ${taskId}`);
  const now = new Date().toISOString();
  const updatedTask = { ...task, status, completion_reason: reason, updated_at: now };
  await saveTask(workspaceRoot, updatedTask);
  await appendTaskAudit(workspaceRoot, taskId, { at: now, type: "correction_closed", reason, status });
  await writeCorrectionTaskCard(workspaceRoot, updatedTask);
  await renderTaskIndex(workspaceRoot);
  return updatedTask;
}

async function readTask(workspaceRoot, taskId) {
  return readJson(path.join(correctionPaths(workspaceRoot).taskRecordsRoot, taskId, "task.json"), null);
}

async function saveTask(workspaceRoot, task) {
  const taskPath = path.join(correctionPaths(workspaceRoot).taskRecordsRoot, task.task_id, "task.json");
  await writeJsonAtomic(taskPath, task);
}

async function appendTaskAudit(workspaceRoot, taskId, entry) {
  await appendJsonLine(path.join(correctionPaths(workspaceRoot).taskRecordsRoot, taskId, "audit.jsonl"), entry);
}

async function linkTaskToTopic(workspaceRoot, topic, task, input = {}) {
  const topicPath = topic._path || path.join(correctionPaths(workspaceRoot).topicsRoot, topic.topic_id, "topic.json");
  const current = await readJson(topicPath, topic);
  const now = new Date().toISOString();
  current.task_ids = unique([...(current.task_ids || []), task.task_id]);
  current.human_event_ids = unique([...(current.human_event_ids || []), ...(input.human_event_ids || [])]);
  current.source_refs = unique([...(current.source_refs || []), ...(input.source_refs || [])]);
  current.updated_at = now;
  await writeJsonAtomic(topicPath, current);
  return { ...current, _path: topicPath };
}

async function writeCorrectionTaskCard(workspaceRoot, task) {
  const cardPath = path.join(correctionPaths(workspaceRoot).cardsRoot, `card-${task.task_card_id}.md`);
  const body = [
    "---",
    `card_id: ${task.task_card_id}`,
    "card_type: task",
    `task_id: ${task.task_id}`,
    `topic_id: ${task.topic_id}`,
    "placement_type: topic",
    `placement_id: ${task.topic_id}`,
    "author: Hermes",
    `occurred_at: ${task.created_at}`,
    `title: ${yamlString(task.title)}`,
    "participants:",
    "  - Hermes",
    `correction_id: ${task.correction_id}`,
    `correction_type: ${task.correction_type}`,
    task.correction_memory_id ? `correction_memory_id: ${task.correction_memory_id}` : "",
    "---",
    "",
    `# ${task.title}`,
    "",
    "## 纠错内容",
    "",
    `- 原行为：${task.original_behavior || "未记录"}`,
    `- 正确行为：${task.correct_behavior || "未记录"}`,
    `- 适用动作：${(task.applies_to_actions || []).join("、") || "待确认"}`,
    `- 目标：${(task.target_refs || []).join("、") || "待确认"}`,
    `- 验证来源：${(task.verification_refs || []).join("、") || "待确认"}`,
    "",
    "## 当前状态",
    `- ${task.status}`,
    task.correction_memory_id ? `- Correction Memory：${task.correction_memory_id}` : "- Correction Memory：尚未创建",
    "",
    "## 完成标准",
    `- ${task.done_criteria}`,
    "",
    "## 来源",
    ...(task.source_refs || []).map((ref) => `- ${ref}`),
    ""
  ].filter(Boolean).join("\n");
  await fs.mkdir(path.dirname(cardPath), { recursive: true, mode: 0o2775 });
  await fs.writeFile(cardPath, body, { mode: 0o664 });
}

function renderTaskContent(input) {
  return [
    `原行为：${input.original_behavior || "未记录"}`,
    `正确行为：${input.correct_behavior || "未记录"}`,
    `适用动作：${(input.applies_to_actions || []).join("、") || "待确认"}`
  ].join("\n");
}

function renderCorrectionMemoryBody(task, input) {
  return [
    `# ${input.title || task.title}`,
    "",
    "## 原行为",
    input.original_behavior || task.original_behavior || "未记录",
    "",
    "## 正确行为",
    input.correct_behavior || task.correct_behavior || "未记录",
    "",
    "## 适用动作",
    (input.applies_to_actions || task.applies_to_actions || []).join("、") || "未限定",
    "",
    "## 目标",
    (input.target_refs || task.target_refs || []).join("、") || "未记录",
    "",
    "## 验证来源",
    (input.verification_refs || task.verification_refs || []).join("、") || "未记录",
    ""
  ].join("\n");
}

function yamlString(value) {
  return JSON.stringify(String(value || ""));
}

async function assertWorkspaceRefs(workspaceRoot, refs) {
  const root = path.resolve(workspaceRoot);
  for (const ref of refs) {
    const value = String(ref || "").trim();
    if (!value || /^https?:\/\//i.test(value)) continue;
    const resolved = path.resolve(root, value);
    if (!resolved.startsWith(root + path.sep)) {
      throw new Error(`Correction target is outside workspace: ${value}`);
    }
    await fs.access(resolved);
  }
}

async function amendCorrectionMemory(workspaceRoot, memoryId, verificationRefs) {
  const recordsRoot = path.join(workspaceRoot, "10-memory", "corrections", "records");
  const files = await walkFiles(recordsRoot, (filePath) => path.extname(filePath).toLowerCase() === ".md");
  for (const filePath of files) {
    const parsed = parseFrontmatter(await fs.readFile(filePath, "utf8"));
    if (String(parsed.data.memory_id || "") !== memoryId) continue;
    const data = {
      ...parsed.data,
      verification_refs: verificationRefs,
      updated_at: new Date().toISOString()
    };
    await fs.writeFile(filePath, renderMemoryDocument(data, parsed.body), { mode: 0o664 });
    return;
  }
  throw new Error(`Correction Memory not found: ${memoryId}`);
}

if (process.argv[1] && process.argv[1].endsWith("correction-registry.mjs")) {
  const [command, workspaceRoot, taskId] = process.argv.slice(2);
  if (command === "ensure-topic") {
    console.log(JSON.stringify(await ensureCorrectionTopic(workspaceRoot), null, 2));
  } else if (command === "close" && workspaceRoot && taskId) {
    console.log(JSON.stringify(await closeCorrectionTask(workspaceRoot, taskId), null, 2));
  }
}
