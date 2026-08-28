#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFanoutCollection } from "./fanout-collection.mjs";

const workspaceRoot = path.resolve(
  process.env.COLLAB_WORKSPACE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
);

try {
  const input = JSON.parse((await readStdin()) || "{}");
  const result = await createFanoutCollection(workspaceRoot, input);
  console.log(JSON.stringify({
    ok: true,
    created: Boolean(result.created),
    deduplicated: Boolean(result.deduplicated),
    task_ids: result.task_ids || [
      result.parent?.task_id,
      result.decomposition?.task_id,
      ...(result.children || []).map((task) => task.task_id)
    ].filter(Boolean),
    parent: result.parent || null,
    decomposition: result.decomposition || null,
    children: result.children || []
  }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}
