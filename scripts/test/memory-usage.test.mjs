import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordMemoryUsage, renderMemoryUsageIndex } from "../memory-usage.mjs";

test("memory usage audit stores refs and never the prompt body", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "memory-usage-"));
  try {
    await recordMemoryUsage(workspace, {
      usage_id: "memory-use-test",
      action: "quoted_message_explanation",
      requester: "Zac",
      subject_person: "Vivi",
      memory_ids: ["memory-dictionary"],
      memory_paths: ["10-memory/dictionary/terms.md"],
      dynamic_refs: ["08-cards/topics/topic-test/topic.json"],
      outcome_ref: "05-agent-outputs/project-hermes/quoted-explanations/test.json",
      prompt: "this must never be persisted"
    });
    const audit = await fs.readFile(path.join(workspace, ".hermes/audit/memory-usage.jsonl"), "utf8");
    assert.ok(audit.includes("memory-use-test"));
    assert.equal(audit.includes("this must never be persisted"), false);
    const index = JSON.parse(await fs.readFile(path.join(workspace, "10-memory/memory-usage-index.json"), "utf8"));
    assert.equal(index.usage_count, 1);
    assert.equal(index.memories[0].usage_count, 1);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("empty memory audit still renders a stable index", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "memory-usage-empty-"));
  try {
    await renderMemoryUsageIndex(workspace);
    const index = JSON.parse(await fs.readFile(path.join(workspace, "10-memory/memory-usage-index.json"), "utf8"));
    assert.deepEqual(index.memories, []);
    assert.equal(index.usage_count, 0);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
