import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.resolve(testDirectory, "..", "render-file-manifest.mjs");

test("file manifest follows the filesystem and enriches entries from file_index", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "file-manifest-"));
  try {
    await write(workspace, "README.md", "# Test Workspace\n\nA readable project entry.\n");
    await write(workspace, "02-notes/wiki/new-note.md", "---\ntitle: New Note\nsummary: Frontmatter summary.\n---\n\nBody.\n");
    await fs.chmod(path.join(workspace, "02-notes/wiki/new-note.md"), 0o600);
    await write(workspace, "04-reports/indexed.md", "# Indexed report\n\nContent fallback.\n");
    await write(workspace, "07-state/file_index.md", [
      "| 路径 | 类型 | 来源 | 一句话摘要 | 状态 | 进入 PROJECT_STATE |",
      "|---|---|---|---|---|---|",
      "| `04-reports/indexed.md` | 报告 | Hermes | Curated summary. | 当前 | ✅ |"
    ].join("\n"));
    await write(workspace, "07-state/runtime.json", "{}\n");
    await write(workspace, "01-raw/intakes/ing-test/manifest.json", "{}\n");
    await write(workspace, "02-notes/intakes/ing-test/analysis.json", "{}\n");
    await write(workspace, "09-tasks/task_index.json", "{}\n");
    await write(workspace, "08-cards/processing/ignored.md", "# Ignore\n");
    await write(workspace, "10-memory/project/identity.md", "---\nmemory_id: test\n---\n\n# Identity\n");

    const result = await runRenderer(workspace);
    assert.equal(result.code, 0, result.stderr);
    const manifest = JSON.parse(await fs.readFile(path.join(workspace, "07-state/file_manifest.json"), "utf8"));
    const paths = manifest.files.map((entry) => entry.path);
    assert.deepEqual(paths, ["02-notes/wiki/new-note.md", "04-reports/indexed.md", "07-state/file_index.md", "10-memory/project/identity.md", "README.md"]);
    assert.equal(manifest.files.find((entry) => entry.path === "04-reports/indexed.md").summary, "Curated summary.");
    assert.equal(manifest.files.find((entry) => entry.path === "02-notes/wiki/new-note.md").summary, "Frontmatter summary.");
    assert.equal(manifest.files.some((entry) => entry.path.endsWith("runtime.json")), false);
    assert.equal(manifest.files.some((entry) => entry.path.includes("processing")), false);
    assert.equal(manifest.directories.find((entry) => entry.path === "02-notes/wiki").file_count, 1);
    assert.equal((await fs.stat(path.join(workspace, "02-notes/wiki/new-note.md"))).mode & 0o777, 0o600);
    assert.equal(manifest.files.find((entry) => entry.path === "02-notes/wiki/new-note.md").published, true);
    assert.equal(manifest.files.some((entry) => entry.path.startsWith("01-raw/")), false);
    assert.equal(manifest.files.some((entry) => entry.path.startsWith("02-notes/intakes/")), false);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

async function write(root, relative, content) {
  const filePath = path.join(root, relative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

function runRenderer(workspace) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [renderer], {
      cwd: workspace,
      env: { ...process.env, COLLAB_WORKSPACE: workspace },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
  });
}
