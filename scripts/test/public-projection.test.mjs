import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(import.meta.dirname, "..", "publish-workspace.mjs");

test("publishes stable snapshots and ignores generated timestamps", async () => {
  const workspace = await createFixture();
  const first = await publish(workspace, "test-first");
  assert.equal(first.changed, true);
  const firstManifest = await readManifest(workspace);

  const second = await publish(workspace, "test-second");
  assert.equal(second.changed, false);
  const secondManifest = await readManifest(workspace);
  assert.equal(secondManifest.data_version, firstManifest.data_version);
  assert.notEqual(secondManifest.generated_at, undefined);
  assert.deepEqual(await fs.readdir(path.join(workspace, "public-data", "versions")), [`data-${firstManifest.data_version}`]);
});

test("publishes content changes and filters private source references", async () => {
  const workspace = await createFixture();
  await publish(workspace, "test-initial");
  const first = await readManifest(workspace);

  await fs.writeFile(path.join(workspace, "README.md"), "# Changed\n", "utf8");
  await writeJson(path.join(workspace, "07-state", "file_manifest.json"), {
    schema_version: 1,
    files: [{ path: "README.md", published: true, url: "/collaborate/README.md" }],
    directories: []
  });
  await publish(workspace, "test-content-change");
  const second = await readManifest(workspace);
  assert.notEqual(second.data_version, first.data_version);
  assert.deepEqual(await fs.readdir(path.join(workspace, "public-data", "versions")), [`data-${second.data_version}`]);

  const cards = await readJson(path.join(workspace, second.datasets.cards));
  assert.deepEqual(cards.cards[0].source_refs, ["03-decisions/rule.md"]);
  assert.equal(cards.cards[0].filesystem_path, undefined);
  assert.equal(JSON.stringify(cards).includes("01-raw"), false);
});

async function createFixture() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-projection-"));
  for (const directory of ["07-state", "08-cards", "09-tasks", "10-memory"]) {
    await fs.mkdir(path.join(workspace, directory), { recursive: true });
  }
  await fs.writeFile(path.join(workspace, "README.md"), "# Fixture\n", "utf8");
  await writeJson(path.join(workspace, "workspace.config.json"), {
    schema_version: 1,
    title: "Fixture",
    status: "test",
    goal: "test",
    creator: { name: "Zac" },
    owner: { name: "Hermes" },
    participants: [{ name: "Zac", kind: "人类", portrait: "test" }],
    tabs: [],
    config: [],
    people_graph: { edges: [] }
  });
  await writeJson(path.join(workspace, "08-cards", "card_index.json"), {
    schema_version: 3,
    generated_at: new Date().toISOString(),
    cards: [{
      card_id: "card-1",
      title: "Fixture Card",
      source_refs: ["01-raw/private.txt", "03-decisions/rule.md"],
      filesystem_path: "/private/path",
      key_points: ["A fact"]
    }],
    card_revisions: [],
    events: [],
    human_events: [],
    topics: [],
    tasks: [],
    briefings: []
  });
  await writeJson(path.join(workspace, "09-tasks", "task_index.json"), { schema_version: 1, tasks: [] });
  await writeJson(path.join(workspace, "07-state", "file_manifest.json"), {
    schema_version: 1,
    files: [{ path: "README.md", published: true, url: "/collaborate/README.md" }],
    directories: []
  });
  await writeJson(path.join(workspace, "07-state", "process-design.json"), { schema_version: 1, sections: [], flow: [] });
  await writeJson(path.join(workspace, "10-memory", "memory-index.json"), { schema_version: 1, records: [] });
  return workspace;
}

async function publish(workspace, reason) {
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, "--reason", reason], {
    env: { ...process.env, COLLAB_WORKSPACE: workspace }
  });
  return JSON.parse(stdout.trim());
}

async function readManifest(workspace) {
  return readJson(path.join(workspace, "public-data", "manifest.json"));
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}
