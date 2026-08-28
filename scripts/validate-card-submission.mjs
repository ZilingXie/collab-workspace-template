#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isTextFile, parseFrontmatter, readJson, relativePath, walkFiles } from "./card-v1-lib.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(process.env.COLLAB_WORKSPACE || path.resolve(scriptDirectory, ".."));
const taskId = argument("--task-id");

if (!taskId) throw new Error("Usage: validate-card-submission.mjs --task-id <local-task-id>");

const task = await readJson(path.join(workspaceRoot, "09-tasks", "tasks", taskId, "task.json"), null);
if (!task || task.task_kind !== "card_submission") finish({ ok: false, reason: "local task is not a card_submission" });

const expectedAuthor = normalizeAuthor(task.owner);
const humanEventId = String((task.human_event_ids || [])[0] || "");
if (!expectedAuthor || !humanEventId) finish({ ok: false, reason: "local task has no expected author or Human Event ID" });

const event = await readJson(path.join(workspaceRoot, "08-cards", "human-events", "records", humanEventId, "event.json"), null);
if (!event) finish({ ok: false, reason: `Human Event ${humanEventId} does not exist` });

const index = await readJson(path.join(workspaceRoot, "08-cards", "card_index.json"), { cards: [] });
const indexed = [...(index.cards || [])]
  .filter((card) => card.human_event_id === humanEventId && normalizeAuthor(card.author) === expectedAuthor)
  .sort((a, b) => String(b.submitted_at || b.created_at).localeCompare(String(a.submitted_at || a.created_at)))[0];
if (indexed) finish({
  ok: true,
  source: "card_index",
  task_id: taskId,
  human_event_id: humanEventId,
  author: expectedAuthor,
  card_id: indexed.card_id,
  artifact_path: indexed.card_path
});

const inbox = path.join(workspaceRoot, "08-cards", "inbox", `${expectedAuthor}-draft`);
for (const filePath of await walkFiles(inbox, isTextFile)) {
  const result = await validateSource(filePath);
  if (result.ok) finish(result);
}

const processingRoot = path.join(workspaceRoot, "08-cards", "processing");
for (const intakePath of await walkFiles(processingRoot, (filePath) => path.basename(filePath) === "intake.json")) {
  const intake = await readJson(intakePath, null);
  if (!intake || normalizeAuthor(intake.owner) !== expectedAuthor) continue;
  for (const candidate of [intake.source_path, intake.source_destination].filter(Boolean)) {
    const filePath = path.join(workspaceRoot, candidate);
    const result = await validateSource(filePath).catch(() => ({ ok: false }));
    if (result.ok) finish(result);
  }
}

finish({
  ok: false,
  task_id: taskId,
  human_event_id: humanEventId,
  author: expectedAuthor,
  reason: `No valid ${expectedAuthor} Personal Card with human_event_id ${humanEventId} was found.`
});

async function validateSource(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = parseFrontmatter(raw);
  const actualEventId = String(parsed.data.human_event_id || "").trim();
  const explicitAuthor = normalizeAuthor(parsed.data.author || expectedAuthor);
  const cardType = String(parsed.data.card_type || "personal").toLowerCase();
  if (actualEventId !== humanEventId || explicitAuthor !== expectedAuthor || cardType !== "personal") return { ok: false };
  return {
    ok: true,
    source: "workspace_file",
    task_id: taskId,
    human_event_id: humanEventId,
    author: expectedAuthor,
    card_id: parsed.data.card_id || null,
    artifact_path: relativePath(workspaceRoot, filePath)
  };
}

function normalizeAuthor(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.includes("vivi")) return "vivi";
  if (normalized.includes("zac")) return "zac";
  return "";
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : String(process.argv[index + 1] || "");
}

function finish(value) {
  console.log(JSON.stringify(value));
  process.exit(value.ok ? 0 : 2);
}
