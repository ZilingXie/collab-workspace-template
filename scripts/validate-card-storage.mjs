#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { getWorkspaceRoot, parseFrontmatter, readJson, walkFiles } from "./card-v1-lib.mjs";

const scriptDirectory = path.dirname(new URL(import.meta.url).pathname);
const workspaceRoot = getWorkspaceRoot(scriptDirectory);
const index = await readJson(path.join(workspaceRoot, "08-cards", "card_index.json"), { cards: [] });
const errors = [];
for (const card of index.cards || []) {
  if (String(card.lifecycle_status || "accepted") !== "accepted") continue;
  const isTaskCard = String(card.card_type || "").toLowerCase() === "task";
  if (!card.card_path || (!isTaskCard && !card.content_path)) errors.push(`${card.card_id}: missing ${isTaskCard ? "card_path" : "card_path/content_path"}`);
  for (const relative of [card.card_path, isTaskCard ? null : card.content_path]) {
    if (!relative) continue;
    try { await fs.access(path.join(workspaceRoot, relative)); } catch { errors.push(`${card.card_id}: missing ${relative}`); }
  }
  if (card.content_id && card.content_id !== card.card_id) errors.push(`${card.card_id}: content_id mismatch`);
}
for (const reviewPath of await walkFiles(path.join(workspaceRoot, "08-cards", "human-events", "records"), (file) => path.basename(file) === "review.json")) {
  const review = await readJson(reviewPath, null);
  if (!review) continue;
  const statuses = [...(review.resolution?.topics || []), ...(review.resolution?.tasks || [])].map((item) => item.status);
  const hasNeedReview = statuses.includes("need_review");
  if (review.status === "need_review" && !hasNeedReview) errors.push(`${reviewPath}: need_review without candidate`);
  if (review.status === "finalized") {
    const task = await readJson(path.join(path.dirname(reviewPath), "review-task.json"), null);
    if (task && !["completed", "expired", "cancelled", "superseded"].includes(task.status)) errors.push(`${reviewPath}: active review task after finalized`);
  }
}
console.log(JSON.stringify({ ok: errors.length === 0, errors }, null, 2));
if (errors.length) process.exitCode = 1;
