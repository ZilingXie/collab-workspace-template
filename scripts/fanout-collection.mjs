#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  appendJsonLine,
  randomId,
  readJson,
  unique,
  writeJsonAtomic
} from "./card-v1-lib.mjs";
import {
  ACTIVE_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  createProjectTask,
  enqueueProjectTask,
  listProjectTasks,
  normalizeInputArtifacts,
  renderTaskIndex,
  taskRegistryPaths
} from "./task-registry.mjs";
import { renderTaskCard } from "./task-result.mjs";

const TERMINAL_CHILD_STATUSES = new Set([
  "completed",
  "completed_before_dispatch",
  "expired",
  "failed",
  "cancelled",
  "superseded"
]);

const STATUS_LABELS = {
  ready: "待开始",
  dispatching: "派发中",
  processing: "进行中",
  in_progress: "进行中",
  completed: "完成",
  completed_before_dispatch: "完成",
  expired: "已到期",
  failed: "失败",
  cancelled: "已取消",
  waiting_collection: "收集中"
};

/**
 * Create the durable three-level fan-out structure:
 * collection coordinator -> decomposition task -> assignee tasks.
 * The coordinator and decomposition task stay local to Project Hermes;
 * only assignee tasks are placed in the AgentRelay queue.
 */
export async function createFanoutCollection(workspaceRoot, input) {
  const assignees = normalizeAssignees(input.assignees);
  if (!assignees.length) throw new Error("fanout collection requires at least one assignee");
  if (input.topic_id) {
    const topicPath = path.join(workspaceRoot, "08-cards", "topics", String(input.topic_id), "topic.json");
    const topic = await readJson(topicPath, null);
    if (!topic || topic.topic_id !== input.topic_id) {
      throw new Error(`fanout collection topic does not exist: ${input.topic_id}`);
    }
  }
  const deadline = input.due_at || input.due_date || new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  if (!deadline || !Number.isFinite(Date.parse(deadline))) {
    throw new Error("fanout collection requires a valid due_at/due_date");
  }
  if (assignees.some((item) => item.risk_level === "L3")) {
    throw new Error("L3 fanout child tasks are prohibited");
  }

  if (input.task_id) {
    const existingById = await readJson(path.join(taskRegistryPaths(workspaceRoot).taskRecordsRoot, input.task_id, "task.json"), null);
    if (existingById?.task_kind === "fanout_collection") {
      existingById.human_event_ids = unique([...(existingById.human_event_ids || []), ...(input.human_event_ids || [])]);
      existingById.source_refs = unique([...(existingById.source_refs || []), ...(input.source_refs || [])]);
      existingById.input_artifacts = normalizeInputArtifacts([...(existingById.input_artifacts || []), ...normalizeInputArtifacts(input.input_artifacts)]);
      existingById.updated_at = new Date().toISOString();
      await saveTask(workspaceRoot, existingById);
      await appendAudit(workspaceRoot, existingById.task_id, {
        at: existingById.updated_at,
        type: "discussed_in_human_event",
        human_event_ids: input.human_event_ids || [],
        status: existingById.status
      });
      await attachInputArtifactsToFanout(workspaceRoot, existingById, input.input_artifacts || [], assignees, input.source_refs || []);
      await refreshFanoutCollection(workspaceRoot, { parentTaskId: existingById.task_id });
      await linkTasksToTopic(workspaceRoot, existingById.topic_id, [existingById.task_id, ...(existingById.child_task_ids || [])]);
      await renderTaskIndex(workspaceRoot);
      return { parent: existingById, created: false, deduplicated: true };
    }
  }

  const dedupeKey = input.dedupe_key || [
    input.origin_ref || "manual:fanout",
    "fanout_collection",
    input.title
  ].join(":");
  const existing = (await listProjectTasks(workspaceRoot)).find((task) => (
    task.task_kind === "fanout_collection"
    && task.dedupe_key === dedupeKey
    && (ACTIVE_TASK_STATUSES.has(task.status) || task.status === "waiting_collection")
  ));
  if (existing) {
    await attachInputArtifactsToFanout(workspaceRoot, existing, input.input_artifacts || [], assignees, input.source_refs || []);
    await refreshFanoutCollection(workspaceRoot, { parentTaskId: existing.task_id });
    await linkTasksToTopic(workspaceRoot, existing.topic_id, [existing.task_id, ...(existing.child_task_ids || [])]);
    await renderTaskIndex(workspaceRoot);
    return { parent: existing, task_ids: [existing.task_id, ...(existing.child_task_ids || [])], created: false, deduplicated: true };
  }

  const now = input.created_at || new Date().toISOString();
  const parentTaskId = input.task_id || randomId("task-", 8);
  const parentCardId = input.task_card_id || randomId("", 8);
  const childDoneCriteria = input.child_done_criteria || input.done_criteria || "参与者提交反馈 Artifact。";
  const coordination = {
    type: "fanout_collection",
    workflow_kind: input.workflow_kind || "",
    coordinator: "project-hermes",
    decomposition_owner: "project-hermes",
    assignees: assignees.map((item) => ({ name: item.name, agent_id: item.agent_id })),
    collection_deadline_at: deadline,
    collection_mode: "deadline_summary",
    child_completion_is_evidence_only: true
  };

  const parentResult = await createProjectTask(workspaceRoot, {
    ...input,
    task_id: parentTaskId,
    task_card_id: parentCardId,
    task_kind: "fanout_collection",
    task_role: "coordinator",
    workflow_kind: input.workflow_kind || "",
    title: input.title,
    content: input.content,
    done_criteria: `到达 ${deadline} 后，Hermes 汇总所有子 Task 的最新状态并将父 Task 收敛为 full、partial 或 no_response。`,
    owner: "Project Hermes",
    target_agent_id: "project-hermes",
    status: "waiting_collection",
    due_at: deadline,
    due_date: deadline,
    dedupe_key: dedupeKey,
    coordination,
    collection_status: "waiting",
    human_event_ids: input.human_event_ids || [],
    source_refs: input.source_refs || [],
    input_artifacts: normalizeInputArtifacts(input.input_artifacts),
    risk_level: input.risk_level || "L1",
    created_at: now
  });
  const parent = parentResult.task;

  const decompositionTaskId = randomId("task-", 8);
  const decompositionCardId = randomId("", 8);
  const decompositionResult = await createProjectTask(workspaceRoot, {
    task_id: decompositionTaskId,
    task_card_id: decompositionCardId,
    task_kind: "fanout_decomposition",
    task_role: "decomposer",
    workflow_kind: input.workflow_kind || "",
    title: `拆分 Task：${input.title}`,
    content: `将收集任务拆分为 ${assignees.map((item) => item.name).join("、")} 的独立反馈 Task，并写入父 Task Card。`,
    owner: "Project Hermes",
    target_agent_id: "project-hermes",
    status: "completed",
    parent_task_id: parentTaskId,
    coordinator_task_id: parentTaskId,
    topic_id: input.topic_id || null,
    human_event_ids: input.human_event_ids || [],
    source_refs: input.source_refs || [],
    input_artifacts: normalizeInputArtifacts(input.input_artifacts),
    done_criteria: "子 Task 已按参与人创建、关联父 Task，并进入唯一派发队列。",
    risk_level: "L0",
    created_at: now,
    completion_reason: "decomposed",
    completion_summary: "Fan-out 子任务已创建并关联。"
  });
  const decomposition = decompositionResult.task;
  await appendAudit(workspaceRoot, decomposition.task_id, {
    at: now,
    type: "decomposed",
    parent_task_id: parentTaskId,
    assignee_count: assignees.length,
    status: decomposition.status
  });

  const children = [];
  for (const assignee of assignees) {
    const childTaskId = randomId("task-", 8);
    const childCardId = randomId("", 8);
    const result = await createProjectTask(workspaceRoot, {
      task_id: childTaskId,
      task_card_id: childCardId,
      task_kind: "fanout_child",
      task_role: "assignee",
      workflow_kind: input.workflow_kind || "",
      title: assignee.title || `${assignee.name} 对 ${input.title} 的反馈`,
      content: assignee.content || input.content,
      owner: assignee.name,
      target_agent_id: assignee.agent_id,
      status: "ready",
      due_at: deadline,
      due_date: deadline,
      topic_id: input.topic_id || null,
      parent_task_id: parentTaskId,
      coordinator_task_id: parentTaskId,
      assignee_role: "feedback_contributor",
      human_event_ids: input.human_event_ids || [],
      source_refs: input.source_refs || [],
      input_artifacts: normalizeInputArtifacts(input.input_artifacts),
      done_criteria: assignee.done_criteria || childDoneCriteria,
      priority: input.priority || "medium",
      risk_level: assignee.risk_level || input.risk_level || "L1",
      dedupe_key: `${dedupeKey}:assignee:${assignee.agent_id}`,
      coordination: {
        ...coordination,
        role: "assignee",
        parent_task_id: parentTaskId,
        decomposition_task_id: decompositionTaskId
      },
      created_at: now
    });
    children.push(result.task);
  }

  parent.child_task_ids = [decompositionTaskId, ...children.map((task) => task.task_id)];
  parent.assignee_task_ids = children.map((task) => task.task_id);
  parent.coordinator_task_id = parentTaskId;
  parent.updated_at = new Date().toISOString();
  parent.summary = null;
  parent.key_points = [];
  await saveTask(workspaceRoot, parent);
  await appendAudit(workspaceRoot, parentTaskId, {
    at: parent.updated_at,
    type: "fanout_created",
    decomposition_task_id: decompositionTaskId,
    child_task_ids: children.map((task) => task.task_id),
    status: parent.status
  });

  decomposition.child_task_ids = children.map((task) => task.task_id);
  decomposition.assignee_task_ids = children.map((task) => task.task_id);
  decomposition.updated_at = parent.updated_at;
  await saveTask(workspaceRoot, decomposition);

  await writeFanoutCards(workspaceRoot, parent, decomposition, children);
  await linkTasksToTopic(workspaceRoot, input.topic_id, [parent.task_id, decomposition.task_id, ...children.map((task) => task.task_id)]);
  for (const child of children) await enqueueProjectTask(workspaceRoot, child);
  await renderTaskIndex(workspaceRoot);
  return {
    parent,
    decomposition,
    children,
    task_ids: [parent.task_id, decomposition.task_id, ...children.map((task) => task.task_id)],
    created: true,
    deduplicated: false
  };
}

/** Refresh cards and finalize due collection coordinators. */
export async function reconcileFanoutCollections(workspaceRoot, options = {}) {
  const tasks = await listProjectTasks(workspaceRoot);
  const parents = tasks.filter((task) => task.task_kind === "fanout_collection");
  const changed = [];
  for (const parent of parents) {
    const childTasks = tasks.filter((task) => parent.assignee_task_ids?.includes(task.task_id));
    const force = options.parentTaskId === parent.task_id || options.force === true;
    const due = Boolean(force || (parent.due_at && Date.parse(parent.due_at) <= (options.now || Date.now())));
    if (due && !TERMINAL_TASK_STATUSES.has(parent.status)) {
      for (const child of childTasks) {
        if (TERMINAL_CHILD_STATUSES.has(child.status)) continue;
        child.status = "expired";
        child.expired_at = new Date(options.now || Date.now()).toISOString();
        child.updated_at = child.expired_at;
        child.completion_reason = "parent_collection_deadline";
        await saveTask(workspaceRoot, child);
        await setQueueStatus(workspaceRoot, child, "expired");
        await appendAudit(workspaceRoot, child.task_id, {
          at: child.expired_at,
          type: "expired_by_collection_deadline",
          parent_task_id: parent.task_id,
          status: child.status,
          trigger_task_id: options.childTaskId || null
        });
      }
      const refreshedChildren = await readTasksById(workspaceRoot, childTasks.map((task) => task.task_id));
      await finalizeParent(workspaceRoot, parent, refreshedChildren, options.now || Date.now());
      changed.push(parent.task_id);
    } else {
      await writeFanoutCardsForParent(workspaceRoot, parent, childTasks);
    }
  }
  await renderTaskIndex(workspaceRoot);
  return { changed, parent_count: parents.length };
}

export async function refreshFanoutCollection(workspaceRoot, { parentTaskId = "", childTaskId = "" } = {}) {
  const tasks = await listProjectTasks(workspaceRoot);
  const parent = parentTaskId
    ? tasks.find((task) => task.task_id === parentTaskId)
    : tasks.find((task) => task.task_id === tasks.find((candidate) => candidate.task_id === childTaskId)?.parent_task_id);
  if (!parent || parent.task_kind !== "fanout_collection") return null;
  const children = await readTasksById(workspaceRoot, parent.assignee_task_ids || []);
  await writeFanoutCardsForParent(workspaceRoot, parent, children);
  return parent;
}

async function finalizeParent(workspaceRoot, parent, children, nowMs) {
  const completed = children.filter((task) => ["completed", "completed_before_dispatch"].includes(task.status));
  const outcome = completed.length === children.length
    ? "full"
    : completed.length > 0 ? "partial" : "no_response";
  const now = new Date(nowMs).toISOString();
  parent.status = "completed";
  parent.completed_at = now;
  parent.updated_at = now;
  parent.completion_reason = "collection_deadline";
  parent.collection_status = outcome;
  parent.collection_outcome = {
    mode: outcome,
    total: children.length,
    completed: completed.map((task) => task.task_id),
    not_completed: children.filter((task) => !completed.includes(task)).map((task) => ({
      task_id: task.task_id,
      owner: task.owner,
      status: task.status
    }))
  };
  parent.summary = buildCollectionSummary(parent, children, outcome);
  parent.key_points = buildCollectionPoints(children, outcome);
  await saveTask(workspaceRoot, parent);
  await appendAudit(workspaceRoot, parent.task_id, {
    at: now,
    type: "collection_finalized",
    status: parent.status,
    collection_status: outcome,
    completed_child_task_ids: completed.map((task) => task.task_id)
  });
  await setQueueStatus(workspaceRoot, parent, "completed");
  await writeFanoutCardsForParent(workspaceRoot, parent, children);
}

function buildCollectionSummary(parent, children, outcome) {
  const completed = children.filter((task) => ["completed", "completed_before_dispatch"].includes(task.status));
  const names = completed.map((task) => task.owner).join("、") || "无人";
  const missing = children.filter((task) => !completed.includes(task)).map((task) => `${task.owner}（${STATUS_LABELS[task.status] || task.status}）`).join("、");
  if (outcome === "full") return `已到期收敛：${names}均完成反馈。`;
  if (outcome === "partial") return `已到期收敛：${names}完成反馈；${missing}未完成。`;
  return `已到期收敛：没有收到有效反馈；${missing || "所有子任务"}未完成。`;
}

function buildCollectionPoints(children, outcome) {
  return [
    `收集结果：${outcome === "full" ? "全部完成" : outcome === "partial" ? "部分完成" : "无人完成"}`,
    ...children.slice(0, 3).map((task) => `${task.owner}：${STATUS_LABELS[task.status] || task.status}`)
  ];
}

async function writeFanoutCardsForParent(workspaceRoot, parent, children) {
  const tasks = await listProjectTasks(workspaceRoot);
  const decomposition = tasks.find((task) => task.task_id === parent.child_task_ids?.[0]);
  await writeFanoutCards(workspaceRoot, parent, decomposition, children);
}

async function writeFanoutCards(workspaceRoot, parent, decomposition, children) {
  if (parent?.task_card_id) await writeTaskCard(workspaceRoot, parent, children, "coordinator");
  if (decomposition?.task_card_id) await writeTaskCard(workspaceRoot, decomposition, children, "decomposer");
  for (const child of children) if (child?.task_card_id) await writeTaskCard(workspaceRoot, child, children, "assignee");
}

async function writeTaskCard(workspaceRoot, task, siblings, role) {
  const auditPath = path.join(workspaceRoot, "09-tasks", "tasks", task.task_id, "audit.jsonl");
  const auditEntries = await readAuditEntries(auditPath);
  await renderTaskCard(workspaceRoot, task, { role, siblings, auditEntries });
}

async function setQueueStatus(workspaceRoot, task, status) {
  const { queuePath } = taskRegistryPaths(workspaceRoot);
  const queue = await readJson(queuePath, []);
  const item = queue.find((entry) => entry.local_task_id === task.task_id);
  if (!item) return;
  item.status = status;
  item.updated_at = new Date().toISOString();
  await writeJsonAtomic(queuePath, queue);
}

async function attachInputArtifactsToFanout(workspaceRoot, parent, incoming, assignees = [], sourceRefs = []) {
  const artifacts = normalizeInputArtifacts([...(parent.input_artifacts || []), ...normalizeInputArtifacts(incoming)]);
  if (!artifacts.length) return;
  const tasks = await listProjectTasks(workspaceRoot);
  const relatedIds = [parent.task_id, ...(parent.child_task_ids || [])].filter(Boolean);
  for (const task of tasks.filter((item) => relatedIds.includes(item.task_id))) {
    task.input_artifacts = normalizeInputArtifacts([...(task.input_artifacts || []), ...artifacts]);
    task.source_refs = unique([...(task.source_refs || []), ...(sourceRefs || [])]);
    if (task.task_kind === "fanout_child") {
      const assignee = assignees.find((item) => item.agent_id === task.owner_agent_id);
      if (assignee?.title) task.title = assignee.title;
      if (assignee?.content) task.content = assignee.content;
      if (assignee?.done_criteria) task.done_criteria = assignee.done_criteria;
    }
    task.updated_at = new Date().toISOString();
    await saveTask(workspaceRoot, task);
    if (task.task_kind === "fanout_child") await enqueueProjectTask(workspaceRoot, task);
    await appendAudit(workspaceRoot, task.task_id, {
      at: task.updated_at,
      type: "input_artifacts_attached",
      task_id: task.task_id,
      artifact_ids: task.input_artifacts.map((artifact) => artifact.artifact_id)
    });
  }
  await writeFanoutCardsForExisting(workspaceRoot, parent, relatedIds);
}

async function writeFanoutCardsForExisting(workspaceRoot, parent, relatedIds) {
  const tasks = await listProjectTasks(workspaceRoot);
  const related = tasks.filter((task) => relatedIds.includes(task.task_id));
  const decomposition = related.find((task) => task.task_kind === "fanout_decomposition") || null;
  const children = related.filter((task) => task.task_kind === "fanout_child");
  const refreshedParent = related.find((task) => task.task_id === parent.task_id) || parent;
  if (refreshedParent.task_card_id) {
    await writeTaskCard(workspaceRoot, refreshedParent, children, "coordinator");
  }
  if (decomposition?.task_card_id) {
    await writeTaskCard(workspaceRoot, decomposition, children, "decomposer");
  }
  for (const child of children) {
    if (child.task_card_id) await writeTaskCard(workspaceRoot, child, children, "assignee");
  }
}

async function saveTask(workspaceRoot, task) {
  const { taskRecordsRoot } = taskRegistryPaths(workspaceRoot);
  await writeJsonAtomic(path.join(taskRecordsRoot, task.task_id, "task.json"), task);
}

async function linkTasksToTopic(workspaceRoot, topicId, taskIds) {
  if (!topicId) return;
  const topicPath = path.join(workspaceRoot, "08-cards", "topics", String(topicId), "topic.json");
  const topic = await readJson(topicPath, null);
  if (!topic) return;
  topic.task_ids = unique([...(topic.task_ids || []), ...taskIds.filter(Boolean)]);
  topic.updated_at = new Date().toISOString();
  await writeJsonAtomic(topicPath, topic);
}

async function appendAudit(workspaceRoot, taskId, entry) {
  const { taskRecordsRoot } = taskRegistryPaths(workspaceRoot);
  await appendJsonLine(path.join(taskRecordsRoot, taskId, "audit.jsonl"), entry);
}

async function readTasksById(workspaceRoot, ids) {
  const tasks = [];
  for (const id of ids || []) {
    const task = await readJson(path.join(taskRegistryPaths(workspaceRoot).taskRecordsRoot, id, "task.json"), null);
    if (task) tasks.push(task);
  }
  return tasks;
}

async function readAuditEntries(filePath) {
  try {
    return (await fs.readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function normalizeAssignees(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    name: String(item?.name || item?.owner || "").trim(),
    agent_id: String(item?.agent_id || item?.target_agent_id || "").trim(),
    title: String(item?.title || "").trim(),
    content: String(item?.content || "").trim(),
    done_criteria: String(item?.done_criteria || "").trim(),
    risk_level: String(item?.risk_level || "L1").toUpperCase()
  })).filter((item) => item.name && item.agent_id);
}

async function main() {
  const workspaceRoot = path.resolve(process.env.COLLAB_WORKSPACE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  if (process.argv.includes("--reconcile")) {
    const childTaskId = argument("--child-task-id");
    const child = childTaskId
      ? await readJson(path.join(taskRegistryPaths(workspaceRoot).taskRecordsRoot, childTaskId, "task.json"), null)
      : null;
    const result = await reconcileFanoutCollections(workspaceRoot, {
      parentTaskId: argument("--task-id") || child?.parent_task_id || "",
      childTaskId,
      force: process.argv.includes("--expired"),
      now: Date.now()
    });
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    return;
  }
  throw new Error("Use --reconcile or import createFanoutCollection() from another workflow.");
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : String(process.argv[index + 1] || "");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
