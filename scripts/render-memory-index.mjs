#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { getWorkspaceRoot, writeJsonAtomic } from "./card-v1-lib.mjs";
import { listValidatedMemoryRecords } from "./memory-registry.mjs";

const scriptDirectory = path.dirname(new URL(import.meta.url).pathname);

export async function renderMemoryIndex(workspaceRoot = getWorkspaceRoot(scriptDirectory)) {
  const records = await listValidatedMemoryRecords(workspaceRoot);
  const outputPath = path.join(workspaceRoot, "10-memory", "memory-index.json");
  records.sort((a, b) => String(a.file_path).localeCompare(String(b.file_path)));
  await writeJsonAtomic(outputPath, {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source: "10-memory",
    record_count: records.length,
    records: records.map((record) => ({
      memory_id: record.memory_id,
      memory_type: record.memory_type,
      status: record.status,
      fact_status: record.fact_status,
      evidence_type: record.evidence_type,
      path: record.file_path,
      source_refs: record.source_refs,
      supersedes: record.supersedes,
      title: record.data.title || record.data.person || record.data.term || record.data.statement || record.memory_id,
      summary: record.data.summary || ""
    }))
  });
  return { ok: true, output: "10-memory/memory-index.json", records: records.length };
}

if (process.argv[1] && process.argv[1].endsWith("render-memory-index.mjs")) {
  const result = await renderMemoryIndex();
  console.log(JSON.stringify(result));
}
