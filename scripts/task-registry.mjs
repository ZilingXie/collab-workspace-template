import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  appendJsonLine,
  randomId,
  readJson,
  relativePath,
  walkFiles,
  writeJsonAtomic
} from "./card-v1-lib.mjs";
import { assertL3Allowed } from "./l3-policy.mjs";

export const ACTIVE_TASK_STATUSES = new Set([
  "ready",
  "dispatching",
  "processing",
  "in_progress",
  "waiting_target_response",
  "waiting_requester_decision",
  "waiting_collection"
]);

export const TERMINAL_TASK_STATUSES = new Set([
  "completed",
  "completed_before_dispatch",
  "expired",
  "failed",
  "cancelled",
  "superseded"
]);

export function taskRegistryPaths(workspaceRoot) {
  const tasksRoot = path.join(workspaceRoot, "09-tasks");
  return {
    tasksRoot,
    taskRecordsRoot: path.join(tasksRoot, "tasks"),
    queuePath: path.join(tasksRoot, "dispatch_queue.json"),
    indexPath: path.join(tasksRoot, "task_index.json")
  };
}

/** Normalize one or more durable documents attached as Task inputs. */
export function normalizeInputArtifacts(value) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  return values
    .map((artifact) => ({
      artifact_id: String(artifact && typeof artifact === "object" ? (artifact.artifact_id || artifact.id || "") : "").trim(),
      kind: String(artifact && typeof artifact === "object" ? (artifact.kind || "document") : "document").trim(),
      title: String(artifact && typeof artifact === "object" ? (artifact.title || artifact.name || artifact.path || "输入材料") : "输入材料").trim(),
      path: String(artifact && typeof artifact === "object" ? (artifact.path || "") : "").trim(),
      url: String(artifact && typeof artifact === "object" ? (artifact.url || artifact.uri || "") : "").trim(),
      sha256: String(artifact && typeof artifact === "object" ? (artifact.sha256 || "") : "").trim().toLowerCase(),
      required: !(artifact && typeof artifact === "object") || artifact.required !== false
    }));
}

/**
 * Check a Task's durable input documents before a Relay dispatch. The local
 * file and hash are authoritative; the URL is a stable public reference that
 * must still be syntactically valid before it is shown to another Agent.
 */
export async function validateInputArtifacts(workspaceRoot, value) {
  const artifacts = normalizeInputArtifacts(value);
  for (const artifact of artifacts) {
    if (!artifact.artifact_id || !artifact.path) return "input_artifact_invalid";
    const relative = artifact.path.replaceAll("\\", "/");
    if (relative.startsWith("/") || relative === ".." || relative.startsWith("../") || relative.includes("/../")) {
      return `input_artifact_path_invalid:${artifact.artifact_id}`;
    }
    const filePath = path.resolve(workspaceRoot, relative);
    const root = path.resolve(workspaceRoot) + path.sep;
    if (!filePath.startsWith(root)) return `input_artifact_path_invalid:${artifact.artifact_id}`;
    let content;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return `input_artifact_missing:${artifact.artifact_id}`;
      content = await fs.readFile(filePath);
    } catch {
      return `input_artifact_missing:${artifact.artifact_id}`;
    }
    if (artifact.sha256 && createHash("sha256").update(content).digest("hex") !== artifact.sha256) {
      return `input_artifact_hash_mismatch:${artifact.artifact_id}`;
    }
    if (artifact.required && !artifact.url) return `input_artifact_url_missing:${artifact.artifact_id}`;
    if (artifact.url) {
      try {
        const parsed = new URL(artifact.url);
        if (!/^https?:$/.test(parsed.protocol)) return `input_artifact_url_invalid:${artifact.artifact_id}`;
      } catch {
        return `input_artifact_url_invalid:${artifact.artifact_id}`;
      }
    }
  }
  return "";
}

export function deriveTaskDedupeKey(input) {
  if (input.dedupe_key) return String(input.dedupe_key);
  const eventId = (input.human_event_ids || [])[0] || "";
  const kind = input.task_kind || "task";
  if (kind === "fanout_collection") {
    return [
      input.origin_ref || (eventId ? `human-event:${eventId}` : "fanout"),
      kind,
      input.title || "collection"
    ].join(":");
  }
  if (eventId && input.target_agent_id) {
    if (kind === "card_submission") {
      return ["human-event", eventId, kind, input.target_agent_id].join(":");
    }
    return ["human-event", eventId, kind, input.target_agent_id, taskSemanticIdentity(input)].join(":");
  }
  if (input.origin_ref && input.target_agent_id) {
    return [String(input.origin_ref), kind, input.target_agent_id].join(":");
  }
  return "";
}

function taskSemanticIdentity(input) {
  const topicAndTitle = [input.topic_id, input.title].filter(Boolean).join(":");
  return String(topicAndTitle || input.origin_ref || input.task_card_id || input.task_id || "task")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .slice(0, 160);
}

export async function listProjectTasks(workspaceRoot) {
  const { taskRecordsRoot } = taskRegistryPaths(workspaceRoot);
  const tasks = [];
  for (const filePath of await walkFiles(taskRecordsRoot, (file) => path.basename(file) === "task.json")) {
    const task = await readJson(filePath, null);
    if (task) tasks.push(task);
  }
  return tasks;
}

export async function createProjectTask(workspaceRoot, input, { enqueue = false } = {}) {
  await assertL3Allowed(workspaceRoot, input, {
    source: "task_registry_create",
    audit: {
      local_task_id: input.task_id,
      human_event_id: (input.human_event_ids || [])[0],
      action_ref: input.origin_ref
    }
  });
  const paths = taskRegistryPaths(workspaceRoot);
  await fs.mkdir(paths.taskRecordsRoot, { recursive: true, mode: 0o2775 });
  const dedupeKey = deriveTaskDedupeKey(input);
  if (dedupeKey) {
    const existing = (await listProjectTasks(workspaceRoot)).find((task) => (
      (task.dedupe_key || deriveTaskDedupeKey({
        ...task,
        target_agent_id: task.owner_agent_id
      })) === dedupeKey && ACTIVE_TASK_STATUSES.has(task.status)
    ));
    if (existing) {
      const incomingArtifacts = normalizeInputArtifacts(input.input_artifacts);
      if (incomingArtifacts.length) {
        const mergedArtifacts = normalizeInputArtifacts([...(existing.input_artifacts || []), ...incomingArtifacts]);
        existing.input_artifacts = mergedArtifacts;
        existing.updated_at = new Date().toISOString();
        await writeJsonAtomic(path.join(paths.taskRecordsRoot, existing.task_id, "task.json"), existing);
        await appendJsonLine(path.join(paths.taskRecordsRoot, existing.task_id, "audit.jsonl"), {
          at: existing.updated_at,
          type: "input_artifacts_attached",
          task_id: existing.task_id,
          artifact_ids: mergedArtifacts.map((artifact) => artifact.artifact_id)
        });
      }
      if (enqueue) await enqueueProjectTask(workspaceRoot, existing);
      return { task: existing, created: false, deduplicated: true };
    }
  }

  const now = input.created_at || new Date().toISOString();
  const taskId = input.task_id || randomId("task-", 8);
  const task = {
    schema_version: 1,
    task_id: taskId,
    task_kind: input.task_kind || "project_action",
    task_role: input.task_role || null,
    workflow_kind: input.workflow_kind || null,
    manager_role: input.manager_role || null,
    review_status: input.review_status || null,
    topic_id: input.topic_id || null,
    title: input.title,
    content: input.content,
    owner: input.owner || displayOwner(input.target_agent_id),
    owner_agent_id: input.target_agent_id,
    status: input.status || "ready",
    due_at: input.due_at || null,
    due_date: input.due_at || null,
    not_before: input.not_before || null,
    blocked_by_human_event_ids: input.blocked_by_human_event_ids || [],
    done_criteria: input.done_criteria,
    human_event_ids: input.human_event_ids || [],
    source_refs: input.source_refs || [],
    input_artifacts: normalizeInputArtifacts(input.input_artifacts),
    priority: input.priority || "medium",
    risk_level: input.risk_level || "L1",
    origin_ref: input.origin_ref || null,
    timeout_policy: input.timeout_policy || null,
    parent_task_id: input.parent_task_id || null,
    child_task_ids: input.child_task_ids || [],
    coordinator_task_id: input.coordinator_task_id || null,
    assignee_task_ids: input.assignee_task_ids || [],
    assignee_role: input.assignee_role || null,
    coordination: input.coordination || null,
    collection_status: input.collection_status || null,
    collection_outcome: input.collection_outcome || null,
    completion_reason: input.completion_reason || null,
    summary: input.summary || null,
    key_points: input.key_points || [],
    dedupe_key: dedupeKey || null,
    task_card_id: input.task_card_id || null,
    relay_task_id: input.relay_task_id || null,
    created_at: now,
    updated_at: now
  };
  const taskDir = path.join(paths.taskRecordsRoot, taskId);
  await fs.mkdir(taskDir, { recursive: true, mode: 0o2775 });
  await writeJsonAtomic(path.join(taskDir, "task.json"), task);
  await appendJsonLine(path.join(taskDir, "audit.jsonl"), {
    at: now,
    type: "created",
    task_id: taskId,
    status: task.status,
    task_kind: task.task_kind,
    dedupe_key: task.dedupe_key
  });
  if (enqueue) await enqueueProjectTask(workspaceRoot, task);
  await renderTaskIndex(workspaceRoot);
  return { task, created: true, deduplicated: false };
}

export async function enqueueProjectTask(workspaceRoot, task) {
  const { queuePath } = taskRegistryPaths(workspaceRoot);
  const queue = await readJson(queuePath, []);
  const existing = queue.find((item) => item.local_task_id === task.task_id);
  const blocked = await taskDispatchBlockReason(workspaceRoot, task);
  if (existing) {
    if (TERMINAL_TASK_STATUSES.has(task.status)) existing.status = task.status;
    else if (!task.relay_task_id && existing.status !== "inflight") existing.status = blocked ? "blocked" : "pending";
    existing.not_before = task.not_before || null;
    existing.blocked_by_human_event_ids = task.blocked_by_human_event_ids || [];
    existing.parent_task_id = task.parent_task_id || null;
    existing.coordinator_task_id = task.coordinator_task_id || null;
    existing.assignee_role = task.assignee_role || null;
    existing.workflow_kind = task.workflow_kind || null;
    existing.coordination = task.coordination || null;
    existing.input_artifacts = normalizeInputArtifacts(task.input_artifacts);
    existing.blocked_reason = blocked || null;
    existing.updated_at = new Date().toISOString();
    await writeJsonAtomic(queuePath, queue);
    return existing;
  }
  const now = new Date().toISOString();
  const item = {
    schema_version: 1,
    local_task_id: task.task_id,
    task_kind: task.task_kind,
    target_agent_id: task.owner_agent_id,
    subject: task.title,
    request_text: task.content,
    done_criteria: task.done_criteria,
    priority: task.priority || "medium",
    risk_level: task.risk_level || "L1",
    source_refs: task.source_refs || [],
    human_event_ids: task.human_event_ids || [],
    due_at: task.due_at || task.due_date || null,
    origin_ref: task.origin_ref || null,
    dedupe_key: task.dedupe_key || null,
    not_before: task.not_before || null,
    blocked_by_human_event_ids: task.blocked_by_human_event_ids || [],
    parent_task_id: task.parent_task_id || null,
    coordinator_task_id: task.coordinator_task_id || null,
    assignee_role: task.assignee_role || null,
    workflow_kind: task.workflow_kind || null,
    coordination: task.coordination || null,
    input_artifacts: normalizeInputArtifacts(task.input_artifacts),
    blocked_reason: blocked || null,
    status: TERMINAL_TASK_STATUSES.has(task.status) ? task.status : (blocked ? "blocked" : "pending"),
    created_at: now,
    updated_at: now
  };
  queue.push(item);
  await writeJsonAtomic(queuePath, queue);
  return item;
}

export async function reconcileDispatchQueue(workspaceRoot) {
  const paths = taskRegistryPaths(workspaceRoot);
  const queue = await readJson(paths.queuePath, []);
  let changed = false;
  for (const item of queue) {
    const taskPath = path.join(paths.taskRecordsRoot, item.local_task_id, "task.json");
    const task = await readJson(taskPath, null);
    const blocked = task ? await taskDispatchBlockReason(workspaceRoot, task) : "";
    const next = !task
      ? "cancelled"
      : TERMINAL_TASK_STATUSES.has(task.status)
        ? task.status
        : task.relay_task_id
          ? "dispatched"
          : blocked
            ? "blocked"
            : "pending";
    if (item.status !== next
      || item.relay_task_id !== (task?.relay_task_id || null)
      || (item.blocked_reason || null) !== (blocked || null)) {
      item.status = next;
      item.relay_task_id = task?.relay_task_id || null;
      item.not_before = task?.not_before || null;
      item.blocked_by_human_event_ids = task?.blocked_by_human_event_ids || [];
      item.blocked_reason = blocked || null;
      item.updated_at = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) await writeJsonAtomic(paths.queuePath, queue);
  return queue;
}

export async function taskDispatchBlockReason(workspaceRoot, task, now = Date.now()) {
  const notBefore = Date.parse(task?.not_before || "");
  if (Number.isFinite(notBefore) && notBefore > now) {
    return `not_before:${task.not_before}`;
  }
  for (const eventId of task?.blocked_by_human_event_ids || []) {
    const event = await readJson(path.join(
      workspaceRoot,
      "08-cards",
      "human-events",
      "records",
      eventId,
      "event.json"
    ), null);
    if (!event || event.status !== "materialized") {
      return `human_event_not_materialized:${eventId}`;
    }
  }
  const artifactBlock = await validateInputArtifacts(workspaceRoot, task?.input_artifacts);
  if (artifactBlock) return artifactBlock;
  return "";
}

export async function renderTaskIndex(workspaceRoot) {
  const paths = taskRegistryPaths(workspaceRoot);
  const tasks = await listProjectTasks(workspaceRoot);
  for (const task of tasks) {
    const taskDir = path.join(paths.taskRecordsRoot, task.task_id);
    task.task_path = relativePath(workspaceRoot, path.join(taskDir, "task.json"));
    task.audit_path = relativePath(workspaceRoot, path.join(taskDir, "audit.jsonl"));
    task.task_card_url = task.task_card_id ? `/collaborate/08-cards/cards/card-${task.task_card_id}.md` : null;
  }
  tasks.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  await writeJsonAtomic(paths.indexPath, {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    task_count: tasks.length,
    tasks
  });
  return tasks;
}

function displayOwner(agentId) {
  if (agentId === "zac-agent") return "Zac";
  if (agentId === "vivi-agent") return "Vivi";
  return agentId || "Unassigned";
}
