#!/usr/bin/env node

import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getWorkspaceRoot } from "./card-v1-lib.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = getWorkspaceRoot(scriptDirectory);
const renderer = path.join(scriptDirectory, "render-file-manifest.mjs");
const processRenderer = path.join(scriptDirectory, "render-process-design.mjs");
const processSource = "03-decisions/project-process-design.md";
const debounceMs = Number(process.env.PROJECT_FILE_MANIFEST_DEBOUNCE_MS || 1500);
const visibleTargets = [
  "README.md",
  "02-notes/",
  "03-decisions/",
  "04-reports/",
  "05-agent-outputs/",
  "06-pdca/",
  "07-state/",
  "08-cards/cards/",
  "08-cards/contents/"
];

let debounceTimer = null;
let rendering = false;
let rerender = false;

await renderOutputs(true);

const watcher = watch(workspaceRoot, { recursive: true }, (_eventType, filename) => {
  const relative = String(filename || "").split(path.sep).join("/");
  if (!shouldRender(relative)) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => renderOutputs(relative === processSource), debounceMs);
});

watcher.on("error", (error) => {
  console.error("file manifest watcher failed", error);
  process.exitCode = 1;
  watcher.close();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearTimeout(debounceTimer);
    watcher.close();
    process.exit(0);
  });
}

console.log(JSON.stringify({ ok: true, watching: workspaceRoot, debounce_ms: debounceMs }));

function shouldRender(relative) {
  if (!relative) return true;
  if (relative === "07-state/file_manifest.json" || relative.startsWith("07-state/file_manifest.json.")) return false;
  if (relative.split("/").some((part) => part.startsWith("."))) return false;
  return visibleTargets.some((target) => target.endsWith("/") ? relative.startsWith(target) : relative === target);
}

async function renderOutputs(renderProcess = false) {
  if (rendering) {
    rerender = true;
    return;
  }
  rendering = true;
  try {
    if (renderProcess) {
      const processCode = await runRenderer(processRenderer);
      if (processCode !== 0) console.error(`process design renderer exited with ${processCode}`);
    }
    const code = await runRenderer(renderer);
    if (code !== 0) console.error(`file manifest renderer exited with ${code}`);
  } finally {
    rendering = false;
    if (rerender) {
      rerender = false;
      await renderOutputs(true);
    }
  }
}

function runRenderer(rendererPath) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [rendererPath], {
      cwd: workspaceRoot,
      env: { ...process.env, COLLAB_WORKSPACE: workspaceRoot },
      stdio: "inherit"
    });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun(code ?? 1));
  });
}
