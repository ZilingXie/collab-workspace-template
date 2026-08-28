#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic, appendJsonLine } from "./card-v1-lib.mjs";
import { reconcileFanoutCollections } from "./fanout-collection.mjs";
import { captureBriefingReviewSnapshot, reconcileBriefing } from "./briefing-workflow.mjs";
import { persistTaskResult, renderTaskCard } from "./task-result.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(process.env.COLLAB_WORKSPACE || path.resolve(scriptDirectory, ".."));
const taskId = argument("--task-id");
const status = argument("--status") || "completed";
const relayTaskId = argument("--relay-task-id") || "";
const summary = argument("--summary") || "Task completed and accepted by Project Hermes.";
const resultFile = argument("--result-file") || "";
const resultEnvelopeRoot = path.resolve(process.env.PROJECT_HERMES_RESULT_ROOT || path.join(workspaceRoot, ".hermes", "result-envelopes"));

if (!taskId) throw new Error("Usage: task-sync.mjs --task-id <local-task-id> --status completed --relay-task-id <relay-task-id>");
if (status !== "completed") throw new Error("task-sync currently only handles completed tasks");

const taskPath = path.join(workspaceRoot, "09-tasks", "tasks", taskId, "task.json");
const task = await readJson(taskPath);
if (!task) throw new Error(`Local task not found: ${taskId}`);
const wasCompleted = task.status === "completed";
if (wasCompleted && !resultFile) {
  console.log(JSON.stringify({ ok: true, task_id: taskId, already_completed: true, task_card_id: task.task_card_id || null }));
  process.exit(0);
}

const now = new Date().toISOString();
const resultInput = resultFile
  ? await readResultEnvelope(resultFile)
  : {
      task_id: taskId,
      relay_task_id: relayTaskId || task.relay_task_id || "",
      result_type: "summary_only",
      summary,
      submitted_text: summary,
      summary_points: [summary],
      submitted_by: "Project Hermes",
      submitted_at: now,
      source_refs: task.source_refs || []
    };
const persisted = task.task_kind === "card_submission"
  ? null
  : await persistTaskResult(workspaceRoot, task, {
      ...resultInput,
      task_id: taskId,
      relay_task_id: relayTaskId || task.relay_task_id || resultInput.relay_task_id || "",
      accepted_at: now,
      accepted_by: "Project Hermes"
    });
if (!wasCompleted) task.status = "completed";
task.relay_task_id = relayTaskId || task.relay_task_id || null;
if (!wasCompleted) task.completed_at = now;
task.completion_summary = String(resultInput.summary || summary).slice(0, 20000);
task.updated_at = now;
if (persisted) {
  task.result_ids = [...new Set([...(task.result_ids || []), persisted.result.result_id])];
  task.latest_result_id = persisted.result.result_id;
  task.latest_result_path = persisted.result_path;
  task.latest_result_markdown_path = persisted.markdown_path;
  task.result_summary_points = persisted.result.summary_points || [];
  task.result_artifacts = persisted.result.artifact_refs || [];
}
await writeJsonAtomic(taskPath, task);
if (persisted) await appendJsonLine(path.join(path.dirname(taskPath), "audit.jsonl"), {
  at: now,
  type: "result_received",
  task_id: taskId,
  result_id: persisted.result.result_id,
  source_message_id: persisted.result.source_message_id || null,
  result_path: persisted.result_path,
  deduplicated: persisted.deduplicated
});
if (!wasCompleted) await appendJsonLine(path.join(path.dirname(taskPath), "audit.jsonl"), {
  at: now,
  type: "completed",
  task_id: taskId,
  relay_task_id: task.relay_task_id,
  status: task.status,
  summary: task.completion_summary,
  evidence: persisted?.result_path || task.submission_card_path || null
});
if (persisted) await appendJsonLine(path.join(path.dirname(taskPath), "audit.jsonl"), {
  at: now,
  type: "result_accepted",
  task_id: taskId,
  result_id: persisted.result.result_id,
  summary_points: persisted.result.summary_points || []
});
if (task.task_card_id) await updateTaskCard(task);

const queuePath = path.join(workspaceRoot, "09-tasks", "dispatch_queue.json");
const queue = await readJson(queuePath, []);
const queueItem = queue.find((item) => item.local_task_id === taskId);
if (queueItem) {
  queueItem.status = "completed";
  queueItem.updated_at = now;
  await writeJsonAtomic(queuePath, queue);
}

if (task.workflow_kind === "briefing_review") {
  await captureBriefingReviewSnapshot(workspaceRoot, taskId, persisted?.result || resultInput, task.relay_task_id || relayTaskId);
}

await import(`./render-card-index.mjs?task-sync=${Date.now()}`);
if (task.parent_task_id || task.task_kind === "fanout_collection" || task.task_kind === "fanout_child") {
  await reconcileFanoutCollections(workspaceRoot, {
    parentTaskId: task.task_kind === "fanout_collection" ? task.task_id : "",
    childTaskId: task.task_kind === "fanout_child" ? task.task_id : ""
  });
  await import(`./render-card-index.mjs?fanout-sync=${Date.now()}`);
}
if (task.workflow_kind === "briefing_review") {
  await reconcileBriefing(workspaceRoot, { child_task_id: taskId });
  await import(`./render-card-index.mjs?briefing-sync=${Date.now()}`);
}
if (task.task_kind === "card_submission") await runHumanEventReconcile();
await publishWorkspace(`hermes-task-completed:${taskId}`);
console.log(JSON.stringify({ ok: true, task_id: taskId, status: task.status, task_card_id: task.task_card_id || null }, null, 2));

async function runHumanEventReconcile() {
  const command = path.join(scriptDirectory, "hermes-human-event-reconcile.mjs");
  await new Promise((resolveRun) => {
    const child = spawn(process.execPath, [command, "--cards", "--reason", `card-submission-completed:${taskId}`], {
      cwd: workspaceRoot,
      env: { ...process.env, COLLAB_WORKSPACE: workspaceRoot },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.on("error", resolveRun);
    child.on("close", resolveRun);
  });
}

async function publishWorkspace(reason) {
  await new Promise((resolveRun) => {
    const child = spawn(process.execPath, [path.join(scriptDirectory, "publish-workspace.mjs"), "--reason", reason], {
      cwd: workspaceRoot,
      env: { ...process.env, COLLAB_WORKSPACE: workspaceRoot },
      stdio: ["ignore", "inherit", "inherit"]
    });
    child.on("error", (error) => {
      console.error("workspace publication failed", error.message || error);
      resolveRun();
    });
    child.on("close", () => resolveRun());
  });
}

async function updateTaskCard(taskRecord) {
  const auditPath = path.join(workspaceRoot, "09-tasks", "tasks", taskRecord.task_id, "audit.jsonl");
  const auditEntries = await readAuditEntries(auditPath);
  await renderTaskCard(workspaceRoot, taskRecord, {
    role: taskRecord.task_role || "assignee",
    auditEntries
  });
}

async function readAuditEntries(filePath) {
  try {
    return (await fs.readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function readResultEnvelope(filePath) {
  const resolved = path.resolve(filePath);
  const workspaceRootResolved = path.resolve(workspaceRoot) + path.sep;
  const resultRootResolved = resultEnvelopeRoot + path.sep;
  if (!resolved.startsWith(workspaceRootResolved) && !resolved.startsWith(resultRootResolved)) {
    throw new Error("result file is outside the allowed result envelope roots");
  }
  const value = await readJson(resolved, null);
  if (!value || typeof value !== "object") throw new Error("result file is not a JSON object");
  return value;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : String(process.argv[index + 1] || "");
}
