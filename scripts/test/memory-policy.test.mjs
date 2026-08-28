import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MemoryPolicyError,
  validateMemoryFile,
  validateMemoryRecord
} from "../memory-policy.mjs";
import {
  createMemoryRecord,
  listValidatedMemoryRecords,
  supersedeMemoryRecord,
  upsertMethodRecord
} from "../memory-registry.mjs";

test("confirmed Memory with a source is valid", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "memory-policy-"));
  try {
    await fs.mkdir(path.join(workspace, "03-decisions"), { recursive: true });
    await fs.writeFile(path.join(workspace, "03-decisions", "rule.md"), "# Rule\n");
    const result = validateMemoryRecord(workspace, {
      data: {
        memory_id: "memory-test",
        memory_type: "consensus",
        status: "active",
        fact_status: "confirmed",
        evidence_type: "authority_pointer",
        statement: "The project uses a file-based Memory directory.",
        source_refs: ["03-decisions/rule.md"]
      },
      body: "The policy text may mention uncertain words without making them facts."
    });
    assert.equal(result.memory_id, "memory-test");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("speculation, missing sources, and unconfirmed facts are rejected", () => {
  const base = {
    memory_id: "memory-test",
    memory_type: "consensus",
    status: "active",
    fact_status: "confirmed",
    evidence_type: "human_statement",
    source_refs: ["03-decisions/rule.md"]
  };
  assert.throws(
    () => validateMemoryRecord("/tmp/workspace", { data: { ...base, statement: "This may be true." } }),
    (error) => error instanceof MemoryPolicyError && error.code === "MEMORY_SPECULATION_FORBIDDEN"
  );
  assert.throws(
    () => validateMemoryRecord("/tmp/workspace", { data: { ...base, statement: "This is true.", source_refs: [] } }),
    (error) => error instanceof MemoryPolicyError && error.code === "MEMORY_SOURCE_REQUIRED"
  );
  assert.throws(
    () => validateMemoryRecord("/tmp/workspace", { data: { ...base, fact_status: "unconfirmed", statement: "This is true." } }),
    (error) => error instanceof MemoryPolicyError && error.code === "MEMORY_FACT_NOT_CONFIRMED"
  );
});

test("registry writes confirmed Memory, renders index records, and supersedes old versions", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "memory-registry-"));
  try {
    await fs.mkdir(path.join(workspace, "03-decisions"), { recursive: true });
    await fs.writeFile(path.join(workspace, "03-decisions", "rule.md"), "# Rule\n");
    const created = await createMemoryRecord(workspace, {
      memory_id: "memory-consensus-old",
      memory_type: "consensus",
      fact_status: "confirmed",
      statement: "RAG is a retrieval and storage approach in this project.",
      evidence_type: "authority_pointer",
      source_refs: ["03-decisions/rule.md"],
      slug: "rag-scope"
    });
    assert.equal(created.created, true);
    const replacement = await supersedeMemoryRecord(workspace, created.file_path, {
      memory_id: "memory-consensus-new",
      memory_type: "consensus",
      fact_status: "confirmed",
      statement: "RAG is a retrieval and storage approach and is not automatically a vector database.",
      evidence_type: "human_correction",
      source_refs: ["03-decisions/rule.md"],
      slug: "rag-scope-v2"
    });
    assert.equal(replacement.memory_id, "memory-consensus-new");
    const records = await listValidatedMemoryRecords(workspace);
    assert.equal(records.filter((record) => record.status === "active").length, 1);
    assert.equal(records.find((record) => record.memory_id === "memory-consensus-old").status, "superseded");
    assert.equal(records.find((record) => record.memory_id === "memory-consensus-new").supersedes, "memory-consensus-old");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("navigation README files are ignored while real Memory remains strict", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "memory-navigation-"));
  try {
    await fs.mkdir(path.join(workspace, "10-memory", "people", "facts"), { recursive: true });
    await fs.mkdir(path.join(workspace, "sources"), { recursive: true });
    await fs.writeFile(path.join(workspace, "10-memory", "people", "facts", "README.md"), "# Person Facts\n");
    await fs.writeFile(path.join(workspace, "sources", "statement.txt"), "base 在上海\n");
    const created = await createMemoryRecord(workspace, {
      memory_id: "memory-person-fact",
      memory_type: "person_fact",
      person: "Zac",
      statement: "base 在上海",
      fact_status: "confirmed",
      evidence_type: "human_statement",
      source_refs: ["sources/statement.txt"],
      slug: "zac-base"
    });
    assert.equal(created.created, true);
    const records = await listValidatedMemoryRecords(workspace);
    assert.deepEqual(records.map((record) => record.memory_id), ["memory-person-fact"]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("memory file validation checks referenced source existence", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "memory-source-"));
  try {
    const filePath = path.join(workspace, "10-memory.md");
    await fs.writeFile(filePath, [
      "---",
      "memory_id: memory-source",
      "memory_type: consensus",
      "status: active",
      "fact_status: confirmed",
      "evidence_type: authority_pointer",
      "source_refs:",
      "  - missing.md",
      "---",
      "",
      "A confirmed fact."
    ].join("\n"));
    await assert.rejects(
      () => validateMemoryFile(workspace, filePath),
      (error) => error instanceof MemoryPolicyError && error.code === "MEMORY_SOURCE_MISSING"
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("confirmed reusable Method Memory is stored and reinforced", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "memory-method-"));
  try {
    await fs.mkdir(path.join(workspace, "source"), { recursive: true });
    await fs.writeFile(path.join(workspace, "source", "event.txt"), "confirmed method source\n");
    const first = await upsertMethodRecord(workspace, {
      memory_id: "memory-method-layered-diagnosis",
      memory_type: "method",
      title: "Layered diagnosis",
      summary: "Trace a missing output from the view to the source and runtime boundary.",
      statement: "Trace a missing output from the view to the source and runtime boundary.",
      fact_status: "confirmed",
      evidence_type: "confirmed_human_event",
      source_refs: ["source/event.txt"],
      human_event_ids: ["he-one"],
      supporting_card_ids: ["zac-card"]
    });
    assert.equal(first.created, true);
    const second = await upsertMethodRecord(workspace, {
      memory_id: "memory-method-layered-diagnosis",
      memory_type: "method",
      title: "Layered diagnosis",
      summary: "Trace a missing output from the view to the source and runtime boundary.",
      statement: "Trace a missing output from the view to the source and runtime boundary.",
      fact_status: "confirmed",
      evidence_type: "confirmed_human_event",
      source_refs: ["source/event.txt"],
      human_event_ids: ["he-two"],
      supporting_card_ids: ["vivi-card"]
    });
    assert.equal(second.reinforced, true);
    const records = await listValidatedMemoryRecords(workspace);
    const method = records.find((record) => record.memory_id === "memory-method-layered-diagnosis");
    assert.equal(method.memory_type, "method");
    assert.deepEqual(method.data.human_event_ids, ["he-one", "he-two"]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("event reconciliation accepts only explicit confirmed memory entries", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "memory-event-"));
  try {
    const eventDir = path.join(workspace, "08-cards", "human-events", "records", "he-test");
    await fs.mkdir(eventDir, { recursive: true });
    await fs.mkdir(path.join(workspace, "08-cards"), { recursive: true });
    await fs.writeFile(path.join(workspace, "source.txt"), "confirmed source\n");
    await fs.writeFile(path.join(eventDir, "event.json"), JSON.stringify({
      human_event_id: "he-test",
      status: "materialized",
      summary_status: "final",
      memory_entries: [
        { memory_id: "memory-confirmed", memory_type: "consensus", status: "confirmed", statement: "The project uses file-based Memory.", source_refs: ["source.txt"] },
        { memory_id: "memory-unconfirmed", memory_type: "consensus", status: "candidate", statement: "This may become a rule.", source_refs: ["source.txt"] }
      ]
    }));
    const script = path.resolve(new URL("../memory-reconcile.mjs", import.meta.url).pathname);
    const { spawn } = await import("node:child_process");
    const result = await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [script, "--human-event-id", "he-test"], { cwd: workspace, env: { ...process.env, COLLAB_WORKSPACE: workspace }, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", rejectRun);
      child.on("close", (code) => resolveRun({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    const records = await listValidatedMemoryRecords(workspace);
    assert.equal(records.some((record) => record.memory_id === "memory-confirmed"), true);
    assert.equal(records.some((record) => record.memory_id === "memory-unconfirmed"), false);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
