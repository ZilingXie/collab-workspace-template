import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const scriptsDirectory = path.resolve(new URL(".", import.meta.url).pathname, "..");
const ingestPath = path.join(scriptsDirectory, "hermes-card-ingest.mjs");

test("empty submission routes to review without calling Hermes", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "card-ingest-empty-"));
  try {
    await mkdir(path.join(workspace, "08-cards", "inbox", "vivi-draft"), { recursive: true });
    await writeFile(path.join(workspace, "08-cards", "inbox", "vivi-draft", "empty.md"), "");
    await run(ingestPath, workspace);
    const reviewDirs = await dirsUnder(path.join(workspace, "08-cards", "review", "vivi"));
    assert.equal(reviewDirs.length, 1);
    const review = await readJson(path.join(reviewDirs[0], "review.json"));
    assert.equal(review.status, "need_review");
    assert.match(review.uncertainty_reason, /empty/i);
    assert.ok(review.task_id, "review must be backed by a clarification task");
    const taskPath = path.join(workspace, "09-tasks", "tasks", review.task_id, "task.json");
    const task = await readJson(taskPath);
    assert.equal(task.task_kind, "card_validation_review");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("orphaned pending_dispatch review gets its clarification task recovered", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "card-ingest-orphan-"));
  try {
    const ingestId = "ing-orphan01";
    const reviewDir = path.join(workspace, "08-cards", "review", "vivi", ingestId);
    await mkdir(reviewDir, { recursive: true });
    await writeFile(path.join(reviewDir, "source.md"), "");
    await writeJson(path.join(reviewDir, "review.json"), {
      schema_version: 1,
      review_kind: "event_ownership",
      ingest_id: ingestId,
      submitted_by: "vivi",
      owner: "Hermes",
      original_filename: "source.md",
      submitted_at: "2026-08-13T07:51:44.731Z",
      summary: "legacy orphan review",
      candidate_events: [],
      hermes_recommendation: "review",
      uncertainty_reason: "legacy run failed before task creation",
      question: "Choose link, create, or ignore for this source.",
      status: "pending_dispatch",
      relay_task_id: null,
      decision: null,
      attempts: 1,
      created_at: "2026-08-13T07:51:44.731Z",
      updated_at: "2026-08-13T07:52:19.081Z"
    });
    await mkdir(path.join(workspace, "08-cards", "processing", ingestId), { recursive: true });
    await writeJson(path.join(workspace, "08-cards", "processing", ingestId, "intake.json"), {
      schema_version: 1,
      ingest_id: ingestId,
      owner: "vivi",
      original_filename: "source.md",
      source_path: `08-cards/processing/${ingestId}/source.md`,
      submitted_at: "2026-08-13T07:51:44.731Z",
      status: "review",
      attempts: 1,
      created_at: "2026-08-13T07:51:44.731Z",
      updated_at: "2026-08-13T07:52:19.081Z"
    });
    await run(ingestPath, workspace);
    const review = await readJson(path.join(reviewDir, "review.json"));
    assert.equal(review.status, "need_review");
    assert.ok(review.task_id, "recovered review must reference a task");
    const queue = await readJson(path.join(workspace, "09-tasks", "dispatch_queue.json"));
    assert.ok(queue.some((entry) => entry.local_task_id === review.task_id && entry.status === "pending"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function run(script, workspace) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: workspace,
      env: { ...process.env, COLLAB_WORKSPACE: workspace, PROJECT_HERMES_COMMAND: "/bin/false" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function dirsUnder(root) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
}
