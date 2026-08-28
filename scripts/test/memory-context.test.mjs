import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildMemoryContext } from "../memory-context.mjs";

test("memory context only exposes active confirmed records for an action", async () => {
  const workspace = await makeMemoryWorkspace();
  try {
    const context = await buildMemoryContext({
      workspaceRoot: workspace,
      action: "quoted_message_explanation",
      requester: "Zac",
      subjectPerson: "Vivi",
      participants: ["Zac", "Vivi"]
    });
    assert.ok(context.usage_id.startsWith("memory-use-"));
    assert.ok(context.memory.some((item) => item.memory_type === "person_profile"));
    assert.ok(context.memory.some((item) => item.memory_type === "dictionary"));
    assert.ok(context.memory.some((item) => item.memory_type === "consensus"));
    assert.equal(context.memory.some((item) => item.memory_id === "memory-inactive"), false);
    assert.ok(context.restrictions.some((item) => item.includes("推测")));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("memory context keeps dynamic objects as explicit references", async () => {
  const workspace = await makeMemoryWorkspace();
  try {
    const context = await buildMemoryContext({
      workspaceRoot: workspace,
      action: "meeting_briefing",
      requester: "Zac",
      participants: ["Zac", "Vivi"],
      humanEventId: "he-test",
      topicId: "topic-test",
      taskId: "task-test"
    });
    assert.deepEqual(context.dynamic_refs, [
      "08-cards/human-events/records/he-test",
      "08-cards/topics/topic-test/topic.json",
      "09-tasks/tasks/task-test/task.json",
      "08-cards/card_index.json",
      "09-tasks/task_index.json"
    ]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

async function makeMemoryWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "memory-context-"));
  const source = path.join(workspace, "source.md");
  await fs.writeFile(source, "confirmed source\n");
  const files = {
    "people/zac.md": frontmatter({ memory_id: "memory-zac", memory_type: "person_profile", person: "Zac" }, "# Zac\nConfirmed role."),
    "people/vivi.md": frontmatter({ memory_id: "memory-vivi", memory_type: "person_profile", person: "Vivi" }, "# Vivi\nConfirmed role."),
    "dictionary/terms.md": frontmatter({ memory_id: "memory-dictionary", memory_type: "dictionary" }, "# Project Dictionary\n\n## Agora\nProject company.\n\n## RAG\nProject retrieval method."),
    "consensus/records/test.md": frontmatter({ memory_id: "memory-consensus", memory_type: "consensus" }, "# Consensus\nA confirmed conclusion."),
    "project/identity.md": frontmatter({ memory_id: "memory-project", memory_type: "project_identity" }, "# Project\nProject identity."),
    "project/inactive.md": frontmatter({ memory_id: "memory-inactive", memory_type: "project_identity", status: "superseded" }, "# Old\nOld identity.")
  };
  for (const [relative, content] of Object.entries(files)) {
    const filePath = path.join(workspace, "10-memory", relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }
  return workspace;
}

function frontmatter(fields, body) {
  return [
    "---",
    `memory_id: ${fields.memory_id}`,
    `memory_type: ${fields.memory_type}`,
    `person: ${fields.person || ""}`,
    `status: ${fields.status || "active"}`,
    `fact_status: ${fields.fact_status || "confirmed"}`,
    "evidence_type: human_statement",
    "source_refs:",
    "  - source.md",
    "---",
    "",
    body,
    ""
  ].filter((line, index) => !(line === "person: " && fields.person === undefined)).join("\n");
}
