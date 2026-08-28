#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { confirmCorrection, createCorrectionTask } from "./correction-registry.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(process.env.COLLAB_WORKSPACE || path.join(scriptDirectory, ".."));
const inputPath = argument("--input");
const confirmTaskId = argument("--confirm");
const input = JSON.parse(inputPath
  ? await fs.readFile(path.resolve(inputPath), "utf8")
  : await readStdin());
let finalResult;
if (confirmTaskId) {
  finalResult = await confirmCorrection(workspaceRoot, confirmTaskId, input);
} else {
  const result = await createCorrectionTask(workspaceRoot, input);
  finalResult = result;
  if (input.confirm === true && result.task?.task_id) {
    finalResult = await confirmCorrection(workspaceRoot, result.task.task_id, input);
  }
}
console.log(JSON.stringify({ ok: true, ...finalResult }, null, 2));

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : String(process.argv[index + 1] || "");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("Provide correction JSON on stdin or with --input <file>");
  return text;
}
