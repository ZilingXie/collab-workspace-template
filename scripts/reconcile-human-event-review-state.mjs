#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { appendJsonLine, getWorkspaceRoot, readJson, relativePath, writeJsonAtomic } from "./card-v1-lib.mjs";
import { renderTaskIndex } from "./task-registry.mjs";
import { loadProjectRoles, projectManager } from "./project-roles.mjs";

const scriptDirectory = path.dirname(new URL(import.meta.url).pathname);
const workspaceRoot = getWorkspaceRoot(scriptDirectory);
const manager = projectManager(await loadProjectRoles(workspaceRoot));
const humanEventId = argument("--human-event-id");
const dryRun = process.argv.includes("--dry-run");
if (!humanEventId) throw new Error("Usage: reconcile-human-event-review-state.mjs --human-event-id <id> [--dry-run]");

const eventDir = path.join(workspaceRoot, "08-cards", "human-events", "records", humanEventId);
const eventPath = path.join(eventDir, "event.json");
const reviewPath = path.join(eventDir, "review.json");
const reviewTaskPath = path.join(eventDir, "review-task.json");
const event = await readJson(eventPath, null);
const review = await readJson(reviewPath, null);
const reviewTask = await readJson(reviewTaskPath, null);
if (!event || !review) throw new Error(`Human Event not found: ${humanEventId}`);

const explicitRejectedTitles = new Set([
  "读取并关联 Vivi Codex 架构反馈到 architecture evolution topic",
  "提取 memory governance / method candidate",
  "查看 Vivi Codex 反馈"
]);
const zacCardId = review.card_ids_by_author?.zac || "fd9e7d4504e20748";
const now = new Date().toISOString();
const resolution = review.resolution || review.consensus || {};
const rejected = [];
for (const item of resolution.tasks || []) {
  if (!explicitRejectedTitles.has(item.title)) continue;
  item.status = "rejected";
  item.reason = "Zac Personal Card explicitly rejected materialization for this Task.";
  item.opposing_card_ids = unique([...(item.opposing_card_ids || []), zacCardId]);
  rejected.push(item.title);
}
resolution.tasks = resolution.tasks || [];
resolution.topics = (resolution.topics || []).map(normalizeItem);
resolution.tasks = resolution.tasks.map(normalizeItem);

const nextEvent = {
  ...event,
  status: "materialized",
  summary_status: event.summary_status === "incomplete" ? event.summary_status : "final",
  updated_at: now,
  review_status: "finalized"
};
const nextReview = {
  ...review,
  status: "finalized",
  review_status: "finalized",
  resolution,
  consensus: resolution,
  manager,
  review_task_id: reviewTask?.task_id || review.review_task_id || null,
  review_resolution: "all_candidates_resolved",
  finalized_at: now,
  updated_at: now
};
const nextTask = reviewTask ? {
  ...reviewTask,
  status: "completed",
  task_role: "manager_review",
  manager_role: manager.role,
  review_status: "finalized",
  completion_reason: "all_candidates_resolved",
  completion_summary: "所有候选项均已确认或明确拒绝，无需继续 Manager Review。",
  completed_at: reviewTask.completed_at || now,
  updated_at: now
} : null;

console.log(JSON.stringify({
  dry_run: dryRun,
  human_event_id: humanEventId,
  rejected_task_titles: rejected,
  event_status: nextEvent.status,
  review_status: nextReview.status,
  review_task_status: nextTask?.status || null
}, null, 2));
if (dryRun) process.exit(0);

await writeJsonAtomic(eventPath, nextEvent);
await writeJsonAtomic(reviewPath, nextReview);
if (nextTask) {
  const taskPath = path.join(workspaceRoot, "09-tasks", "tasks", nextTask.task_id, "task.json");
  const auditPath = path.join(path.dirname(taskPath), "audit.jsonl");
  await writeJsonAtomic(taskPath, nextTask);
  await appendJsonLine(auditPath, {
    at: now,
    type: "completed",
    task_id: nextTask.task_id,
    reason: "all_candidates_resolved",
    human_event_id: humanEventId
  });
  const queuePath = path.join(workspaceRoot, "09-tasks", "dispatch_queue.json");
  const queue = await readJson(queuePath, []);
  const queueItem = queue.find((item) => item.local_task_id === nextTask.task_id);
  if (queueItem) {
    queueItem.status = "completed";
    queueItem.updated_at = now;
    await writeJsonAtomic(queuePath, queue);
  }
  await writeJsonAtomic(reviewTaskPath, nextTask);
}
await appendJsonLine(path.join(workspaceRoot, "08-cards", "human-events", "pipeline.jsonl"), {
  at: now,
  event: "human_event.review_reconciled",
  human_event_id: humanEventId,
  review_status: "finalized",
  rejected_task_titles: rejected,
  reason: "all_candidates_resolved"
});
await renderTaskIndex(workspaceRoot);
await import(`./render-card-index.mjs?reconcile=${Date.now()}`);

function normalizeItem(item) {
  const status = ["approved", "rejected", "need_review", "rejected_l3"].includes(item.status)
    ? item.status
    : (item.status === "needs_zac_review" || item.status === "pending_zac_review" ? "need_review" : "need_review");
  return { ...item, status };
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}
