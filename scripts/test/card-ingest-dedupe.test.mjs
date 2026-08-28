import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const scriptsDirectory = path.resolve(new URL(".", import.meta.url).pathname, "..");
const ingestPath = path.join(scriptsDirectory, "hermes-card-ingest.mjs");

test("same Human Event artifact submitted three times yields one accepted card", async () => {
  const workspace = await makeBoundWorkspace("he-duplicate");
  try {
    const artifact = cardArtifact("he-duplicate", "Zac", "Same submission");
    const inbox = path.join(workspace, "08-cards", "inbox", "zac-draft");
    await Promise.all([
      writeFile(path.join(inbox, "one.md"), artifact),
      writeFile(path.join(inbox, "two.md"), artifact),
      writeFile(path.join(inbox, "three.md"), artifact)
    ]);
    await run(ingestPath, workspace);
    const index = await readJson(path.join(workspace, "08-cards", "card_index.json"));
    const accepted = index.cards.filter((card) => card.human_event_id === "he-duplicate" && card.author === "Zac");
    assert.equal(accepted.length, 1);
    assert.equal(index.card_revisions.length, 0);
    const event = await readJson(path.join(workspace, "08-cards", "human-events", "records", "he-duplicate", "event.json"));
    assert.deepEqual(event.personal_card_ids, [accepted[0].card_id]);
    assert.equal((await filesUnder(path.join(workspace, "08-cards", "quarantine"), "card-")).length, 2);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("same author with changed content creates a revision and hides the old card", async () => {
  const workspace = await makeBoundWorkspace("he-revision");
  try {
    const inbox = path.join(workspace, "08-cards", "inbox", "zac-draft");
    await writeFile(path.join(inbox, "first.md"), cardArtifact("he-revision", "Zac", "First submission"));
    await run(ingestPath, workspace);
    await writeFile(path.join(inbox, "second.md"), cardArtifact("he-revision", "Zac", "Updated submission"));
    await run(ingestPath, workspace);
    const index = await readJson(path.join(workspace, "08-cards", "card_index.json"));
    const accepted = index.cards.filter((card) => card.human_event_id === "he-revision" && card.author === "Zac");
    const revisions = index.card_revisions.filter((card) => card.human_event_id === "he-revision" && card.author === "Zac");
    assert.equal(accepted.length, 1);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].lifecycle_status, "superseded");
    assert.equal(revisions[0].superseded_by_card_id, accepted[0].card_id);
    const event = await readJson(path.join(workspace, "08-cards", "human-events", "records", "he-revision", "event.json"));
    assert.deepEqual(event.personal_card_ids, [accepted[0].card_id]);
    assert.deepEqual(event.card_revision_ids_by_author.zac, [revisions[0].card_id]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function cardArtifact(humanEventId, author, conclusion) {
  return [
    "---",
    `human_event_id: ${humanEventId}`,
    "card_type: personal",
    `author: ${author}`,
    "occurred_at: 2026-08-13T02:00:00.000Z",
    'title: "Zac submission"',
    "participants:",
    `  - ${author}`,
    "---",
    "",
    "# Zac submission",
    "",
    "## 讨论结论",
    `- ${conclusion}`,
    ""
  ].join("\n");
}

async function makeBoundWorkspace(humanEventId) {
  const workspace = await mkdtemp(path.join(tmpdir(), "card-ingest-dedupe-"));
  const eventDir = path.join(workspace, "08-cards", "human-events", "records", humanEventId);
  await mkdir(path.join(workspace, "08-cards", "inbox", "zac-draft"), { recursive: true });
  await mkdir(eventDir, { recursive: true });
  await writeJson(path.join(eventDir, "event.json"), {
    human_event_id: humanEventId,
    type: "meeting",
    title: "Dedupe event",
    personal_card_ids: [],
    source_refs: []
  });
  await writeJson(path.join(eventDir, "review.json"), {
    human_event_id: humanEventId,
    status: "pending_cards",
    human_card_ids: []
  });
  return workspace;
}

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

async function filesUnder(root, prefix) {
  const result = [];
  async function walk(directory) {
    let entries = [];
    try { entries = await import("node:fs/promises").then((fs) => fs.readdir(directory, { withFileTypes: true })); }
    catch { return; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.startsWith(prefix)) result.push(file);
    }
  }
  await walk(root);
  return result;
}
