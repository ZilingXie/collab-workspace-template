#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const steps = [
  { name: "bound-card-ingest", file: path.join(directory, "hermes-card-ingest.mjs"), args: ["--bound-only"] },
  { name: "draft-routing", file: path.join(directory, "hermes-draft-router.mjs"), args: [] },
  { name: "human-event-pipeline", file: path.join(directory, "human-event-pipeline.mjs") }
];

for (const step of steps) {
  const result = await run(step.file, step.args || []);
  if (result.code !== 0) {
    console.error(`${step.name} failed with exit code ${result.code}`);
    process.exitCode = result.code || 1;
    break;
  }
}

const manifestResult = await run(path.join(directory, "render-file-manifest.mjs"));
if (manifestResult.code !== 0) {
  console.error(`file-manifest failed with exit code ${manifestResult.code}`);
  if (!process.exitCode) process.exitCode = manifestResult.code || 1;
}

function run(file, args = []) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd: process.env.COLLAB_WORKSPACE || path.resolve(directory, ".."),
      env: { ...process.env, PROJECT_HERMES_09_INGEST: "1" },
      stdio: "inherit"
    });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code: code ?? 1 }));
  });
}
