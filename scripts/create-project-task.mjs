#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProjectTask } from "./task-registry.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(process.env.COLLAB_WORKSPACE || path.resolve(directory, ".."));
const inputPath = argument("--input");
const input = inputPath
  ? JSON.parse(await fs.readFile(path.resolve(inputPath), "utf8"))
  : JSON.parse(await readStdin());
const result = await createProjectTask(workspace, input, { enqueue: true });
console.log(JSON.stringify({ ok: true, created: result.created, deduplicated: result.deduplicated, task: result.task }, null, 2));

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : String(process.argv[index + 1] || "");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("Provide task JSON on stdin or with --input <file>");
  return text;
}
