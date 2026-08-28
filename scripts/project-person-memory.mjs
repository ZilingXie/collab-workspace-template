#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createMemoryRecord, listValidatedMemoryRecords } from "./memory-registry.mjs";
import { renderMemoryIndex } from "./render-memory-index.mjs";

export async function savePersonFact(workspaceRoot, input) {
  const person = String(input?.person || "").trim();
  const statement = String(input?.statement || "").replace(/\s+/gu, " ").trim();
  if (!person) throw new Error("PERSON_REQUIRED");
  if (!statement) throw new Error("STATEMENT_REQUIRED");

  const existing = await listValidatedMemoryRecords(workspaceRoot, { includeNavigation: true });
  const duplicate = existing.find((record) => (
    record.status === "active"
    && record.memory_type === "person_fact"
    && String(record.data?.person || "").toLowerCase() === person.toLowerCase()
    && String(record.data?.statement || record.body || "").replace(/\s+/gu, " ").trim() === statement
  ));
  if (duplicate) {
    return { ok: true, status: "duplicate", memory_id: duplicate.memory_id, file_path: duplicate.file_path };
  }

  const receiptId = `person-memory-${crypto.randomBytes(8).toString("hex")}`;
  const receiptRelative = `.hermes/evidence/person-memory/${receiptId}.json`;
  const receiptPath = path.join(workspaceRoot, receiptRelative);
  await fs.mkdir(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(receiptPath, `${JSON.stringify({
    schema_version: 1,
    receipt_id: receiptId,
    evidence_type: "human_statement",
    person,
    statement,
    sender_ref: String(input.sender_ref || ""),
    group_ref: String(input.group_ref || ""),
    message_ref: String(input.message_ref || ""),
    captured_at: String(input.captured_at || new Date().toISOString())
  }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await fs.chmod(receiptPath, 0o600);

  try {
    const result = await createMemoryRecord(workspaceRoot, {
      memory_id: `memory-${receiptId}`,
      memory_type: "person_fact",
      person,
      title: statement,
      statement,
      status: "active",
      fact_status: "confirmed",
      evidence_type: "human_statement",
      source_refs: [receiptRelative],
      slug: `${person.toLowerCase()}-${receiptId}`
    });
    const index = await renderMemoryIndex(workspaceRoot);
    return { ok: true, status: "created", ...result, index };
  } catch (error) {
    await fs.rm(receiptPath, { force: true });
    throw error;
  }
}

if (process.argv[1] && process.argv[1].endsWith("project-person-memory.mjs")) {
  const workspaceRoot = process.argv[2];
  let inputText = process.argv[3] && process.argv[3] !== "-" ? process.argv[3] : "";
  if (!inputText) {
    inputText = await new Promise((resolve, reject) => {
      let value = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { value += chunk; });
      process.stdin.on("end", () => resolve(value));
      process.stdin.on("error", reject);
    });
  }
  const input = JSON.parse(inputText || "{}");
  console.log(JSON.stringify(await savePersonFact(workspaceRoot, input)));
}
