#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(process.env.COLLAB_WORKSPACE || path.resolve(scriptDirectory, ".."));
const lockHeld = process.argv.includes("--lock-held");
const fullIngest = process.argv.includes("--full-ingest");
const cardsChanged = process.argv.includes("--cards");
const chatInbox = process.argv.includes("--chat-inbox");
const stabilityMs = Number(process.env.PROJECT_HERMES_CARD_STABILITY_MS || 1500);

if (!lockHeld) {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || "/tmp";
  const lockPath = path.join(runtimeDir, "project-hermes-human-event.lock");
  const forwarded = process.argv.slice(2).filter((arg) => arg !== "--lock-held");
  const result = await run("/usr/bin/flock", [
    "-w", "1800", lockPath,
    process.execPath, fileURLToPath(import.meta.url),
    "--lock-held",
    ...forwarded
  ]);
  process.exitCode = result.code;
} else {
  if ((cardsChanged || chatInbox) && stabilityMs > 0) await delay(stabilityMs);
  const steps = chatInbox
    ? [path.join(scriptDirectory, "human-event-pipeline.mjs")]
    : fullIngest
    ? [path.join(scriptDirectory, "hermes-09-ingest.mjs")]
    : [
        ...(cardsChanged ? [path.join(scriptDirectory, "hermes-card-ingest.mjs")] : []),
        path.join(scriptDirectory, "human-event-pipeline.mjs")
      ];
  for (const file of steps) {
    const timeoutTaskId = argument("--review-timeout-task-id");
    const args = chatInbox && file.endsWith("human-event-pipeline.mjs")
      ? ["--chat-only"]
      : (file.endsWith("human-event-pipeline.mjs")
        ? ["--finalize-only", ...(timeoutTaskId ? ["--review-timeout-task-id", timeoutTaskId] : [])]
        : []);
    const result = await run(process.execPath, [file, ...args]);
    if (result.code !== 0) {
      process.exitCode = result.code;
      break;
    }
  }
  const fanoutResult = await run(process.execPath, [
    path.join(scriptDirectory, "fanout-collection.mjs"),
    "--reconcile",
    "--reason",
    argument("--reason") || "reconcile"
  ]);
  if (fanoutResult.code !== 0) process.exitCode = fanoutResult.code;
  const memoryResult = await run(process.execPath, [
    path.join(scriptDirectory, "memory-reconcile.mjs"),
    "--reconcile-events"
  ]);
  if (memoryResult.code !== 0) process.exitCode = memoryResult.code;

  if (!process.exitCode) {
    const publishResult = await run(process.execPath, [
      path.join(scriptDirectory, "publish-workspace.mjs"),
      "--reason",
      argument("--reason") || "hermes-human-event-completed"
    ]);
    if (publishResult.code !== 0) console.error("public workspace projection is pending the scheduled reconcile");
  }
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot,
      env: { ...process.env, COLLAB_WORKSPACE: workspaceRoot },
      stdio: "inherit"
    });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code: code ?? 1 }));
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : String(process.argv[index + 1] || "");
}
