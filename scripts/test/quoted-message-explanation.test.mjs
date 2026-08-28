import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { explainQuotedMessage, readDynamicContext } from "../explain-quoted-message.mjs";

test("quoted explanation reads dictionary, consensus, and explicit Human Event/Topic context", async () => {
  const workspace = await makeWorkspace();
  try {
    const result = await explainQuotedMessage({
      workspaceRoot: workspace,
      quotedText: "Agora 的 RAG 方案需要继续确认",
      requester: "Zac",
      speaker: "Vivi",
      humanEventId: "he-test",
      topicId: "topic-test"
    });
    const output = result.output;
    assert.equal(output.dynamic_context.some((item) => item.type === "human_event" && item.id === "he-test"), true);
    assert.equal(output.dynamic_context.some((item) => item.type === "topic" && item.id === "topic-test"), true);
    assert.ok(output.key_concepts.some((item) => item.matched_terms.includes("Agora")));
    assert.ok(output.key_concepts.some((item) => item.matched_terms.includes("RAG")));
    assert.match(output.ambiguity, /显式指定/);
    assert.equal(output.source_refs.includes("08-cards/human-events/records/he-test/event.json"), true);
    assert.equal(output.source_refs.includes("08-cards/topics/topic-test/topic.json"), true);
    assert.equal(output.memory_usage_id, result.context.usage_id);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("quoted explanation does not guess historical context without IDs", async () => {
  const workspace = await makeWorkspace();
  try {
    const result = await explainQuotedMessage({ workspaceRoot: workspace, quotedText: "这需要再确认", requester: "Zac", speaker: "Vivi" });
    assert.deepEqual(result.output.dynamic_context, []);
    assert.match(result.output.ambiguity, /没有提供 Human Event 或 Topic ID/);
    assert.deepEqual(result.output.dynamic_refs, []);
    assert.deepEqual(result.output.missing_dynamic_context, []);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("missing explicit dynamic IDs are reported instead of silently ignored", async () => {
  const workspace = await makeWorkspace();
  try {
    const dynamic = await readDynamicContext(workspace, { humanEventId: "he-missing", topicId: "topic-missing" });
    assert.equal(dynamic.context.length, 0);
    assert.equal(dynamic.missing.length, 2);
    assert.match(dynamic.missing[0].message, /he-missing/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

async function makeWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "quoted-explanation-"));
  await fs.writeFile(path.join(workspace, "source.md"), "source\n");
  const files = {
    "people/zac.md": memoryFile("memory-zac", "person_profile", "person: Zac"),
    "people/vivi.md": memoryFile("memory-vivi", "person_profile", "person: Vivi"),
    "dictionary/terms.md": memoryFile("memory-dictionary", "dictionary", "", "# Project Dictionary\n\n## Agora\nZac and Vivi's company.\n\n## RAG\nA project retrieval method."),
    "consensus/records/one.md": memoryFile("memory-consensus", "consensus", "", "# Consensus\nRAG is not automatically a vector database."),
    "project/identity.md": memoryFile("memory-project", "project_identity", "", "# Project\nShared workspace project.")
  };
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(workspace, "10-memory", relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const eventFile = path.join(workspace, "08-cards/human-events/records/he-test/event.json");
  const topicFile = path.join(workspace, "08-cards/topics/topic-test/topic.json");
  await writeJson(eventFile, { human_event_id: "he-test", title: "Test Human Event", summary: "A confirmed event summary", occurred_at: "2026-08-13T01:00:00Z", source_refs: ["source.md"] });
  await writeJson(topicFile, { topic_id: "topic-test", title: "Test Topic", current_summary: "A topic summary", human_event_ids: ["he-test"], source_refs: ["source.md"] });
  await writeJson(path.join(workspace, "08-cards/card_index.json"), { cards: [{ card_id: "card-vivi", author: "Vivi", lifecycle_status: "accepted", human_event_id: "he-test", topic_id: "topic-test", title: "Vivi card", summary: "A card summary", source_refs: ["source.md"] }] });
  return workspace;
}

function memoryFile(id, type, extra = "", body = "Confirmed memory.") {
  return `---\nmemory_id: ${id}\nmemory_type: ${type}\n${extra ? `${extra}\n` : ""}status: active\nfact_status: confirmed\nevidence_type: human_statement\nsource_refs:\n  - source.md\n---\n\n${body}\n`;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
}
