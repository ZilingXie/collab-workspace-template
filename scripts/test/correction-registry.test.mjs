import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { confirmCorrection, createCorrectionTask } from "../correction-registry.mjs";
import { listValidatedMemoryRecords } from "../memory-registry.mjs";
import { buildMemoryContext } from "../memory-context.mjs";

test("correction topic, task, card, and memory form one idempotent chain", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "correction-registry-"));
  try {
    await fs.mkdir(path.join(workspace, "sources"), { recursive: true });
    await fs.mkdir(path.join(workspace, "03-decisions"), { recursive: true });
    await fs.writeFile(path.join(workspace, "sources", "correction.md"), "A human correction source.\n");
    await fs.writeFile(path.join(workspace, "03-decisions", "project-process-design.md"), "Current project process.\n");
    const input = {
      title: "纠正项目状态回答方式",
      correction_type: "process",
      original_behavior: "只回答抽象目标。",
      correct_behavior: "回答项目状态时同时说明当前进度和下一步。",
      applies_to_actions: ["project_question"],
      target_refs: ["03-decisions/project-process-design.md"],
      verification_refs: ["03-decisions/project-process-design.md"],
      source_refs: ["sources/correction.md"],
      dedupe_key: "correction:test:project-status",
      status: "ready"
    };
    const first = await createCorrectionTask(workspace, input);
    const second = await createCorrectionTask(workspace, input);
    assert.equal(first.created, true);
    assert.equal(second.deduplicated, true);
    assert.equal(second.task.task_id, first.task.task_id);
    assert.equal(first.topic.task_ids.length, 1);
    assert.equal(await fs.stat(path.join(workspace, "08-cards", "cards", `card-${first.task.task_card_id}.md`)).then(() => true), true);

    const confirmed = await confirmCorrection(workspace, first.task.task_id, {
      memory_id: "correction-memory-test",
      source_refs: ["sources/correction.md"],
      verification_refs: ["03-decisions/project-process-design.md"]
    });
    assert.equal(confirmed.task.status, "completed");
    assert.equal(confirmed.memory_id, "correction-memory-test");
    const records = await listValidatedMemoryRecords(workspace);
    assert.equal(records.some((record) => record.memory_id === "correction-memory-test"), true);

    const projectContext = await buildMemoryContext({ workspaceRoot: workspace, action: "project_question" });
    assert.equal(projectContext.memory_refs.includes("correction-memory-test"), true);
    const termContext = await buildMemoryContext({ workspaceRoot: workspace, action: "term_resolution" });
    assert.equal(termContext.memory_refs.includes("correction-memory-test"), false);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
