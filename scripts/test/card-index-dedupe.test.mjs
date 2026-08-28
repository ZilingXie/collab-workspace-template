import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const scriptsDirectory = path.resolve(new URL(".", import.meta.url).pathname, "..");
const renderPath = path.join(scriptsDirectory, "render-card-index.mjs");

test("card index keeps one record when the same Card ID is in two scan roots", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "card-index-dedupe-"));
  try {
    const legacy = path.join(workspace, "08-cards", "cards");
    const eventCards = path.join(workspace, "08-cards", "events", "evt-test", "cards");
    await mkdir(legacy, { recursive: true });
    await mkdir(eventCards, { recursive: true });
    const card = [
      "---",
      "card_id: same-card-id",
      "event_id: evt-test",
      "card_type: personal",
      "author: Zac",
      "occurred_at: 2026-08-13T00:00:00.000Z",
      'title: "Same card"',
      "---",
      "",
      "# Same card",
      "",
      "## 卡片要点",
      "- One accepted card.",
      ""
    ].join("\n");
    await writeFile(path.join(legacy, "card-same-card-id.md"), card);
    await writeFile(path.join(eventCards, "duplicate-copy.md"), card);
    await run(renderPath, workspace);
    const index = JSON.parse(await readFile(path.join(workspace, "08-cards", "card_index.json"), "utf8"));
    assert.equal(index.cards.filter((item) => item.card_id === "same-card-id").length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("card index excludes orphan schema-v1 briefings", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "card-index-legacy-briefing-"));
  try {
    const briefingRoot = path.join(workspace, "05-agent-outputs", "project-hermes", "meeting-briefings");
    await mkdir(briefingRoot, { recursive: true });
    await writeFile(path.join(briefingRoot, "briefing-orphan.md"), "# Orphan Briefing\n");
    await writeFile(path.join(briefingRoot, "briefing-orphan.json"), JSON.stringify({
      schema_version: 1, briefing_id: "briefing-orphan", markdown_path: "05-agent-outputs/project-hermes/meeting-briefings/briefing-orphan.md"
    }) + "\n");
    await run(renderPath, workspace);
    const index = JSON.parse(await readFile(path.join(workspace, "08-cards", "card_index.json"), "utf8"));
    assert.deepEqual(index.briefings, []);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function run(script, workspace) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: workspace,
      env: { ...process.env, COLLAB_WORKSPACE: workspace },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}
