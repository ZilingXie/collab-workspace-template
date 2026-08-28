import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createProjectTask,
  reconcileDispatchQueue,
  taskRegistryPaths,
  validateInputArtifacts
} from "../task-registry.mjs";
import { createFanoutCollection, reconcileFanoutCollections } from "../fanout-collection.mjs";
import { persistTaskResult } from "../task-result.mjs";

test("active semantic task is deduplicated by event, kind, and target", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "task-registry-"));
  try {
    const input = {
      task_kind: "card_submission",
      title: "Submit card",
      content: "Submit the card.",
      target_agent_id: "zac-agent",
      human_event_ids: ["he-test"],
      origin_ref: "human-event:he-test",
      done_criteria: "Card exists."
    };
    const first = await createProjectTask(workspace, input, { enqueue: true });
    const second = await createProjectTask(workspace, { ...input, title: "Different wording" }, { enqueue: true });
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.task.task_id, first.task.task_id);
    const queue = JSON.parse(await fs.readFile(taskRegistryPaths(workspace).queuePath, "utf8"));
    assert.equal(queue.length, 1);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("distinct topic tasks in one event do not collide", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "task-registry-"));
  try {
    const common = {
      task_kind: "topic_task",
      content: "Do the work.",
      target_agent_id: "zac-agent",
      human_event_ids: ["he-test"],
      origin_ref: "human-event:he-test",
      done_criteria: "Artifact exists."
    };
    const first = await createProjectTask(workspace, { ...common, title: "Build timeline" }, { enqueue: true });
    const second = await createProjectTask(workspace, { ...common, title: "Review protocol" }, { enqueue: true });
    const duplicate = await createProjectTask(workspace, { ...common, title: "Build timeline" }, { enqueue: true });

    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.task.task_id, first.task.task_id);
    const queue = JSON.parse(await fs.readFile(taskRegistryPaths(workspace).queuePath, "utf8"));
    assert.equal(queue.length, 2);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("queue reconciliation prevents terminal local tasks from dispatching", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "task-registry-"));
  try {
    const created = await createProjectTask(workspace, {
      task_kind: "project_action",
      title: "Completed action",
      content: "Already done.",
      target_agent_id: "vivi-agent",
      origin_ref: "test:completed",
      done_criteria: "Done."
    }, { enqueue: true });
    const paths = taskRegistryPaths(workspace);
    const taskPath = path.join(paths.taskRecordsRoot, created.task.task_id, "task.json");
    const task = JSON.parse(await fs.readFile(taskPath, "utf8"));
    task.status = "completed";
    await fs.writeFile(taskPath, JSON.stringify(task, null, 2) + "\n");
    const queue = await reconcileDispatchQueue(workspace);
    assert.equal(queue[0].status, "completed");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("fanout creates local coordinator/decomposer and relay child tasks", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "task-fanout-"));
  try {
    const result = await createFanoutCollection(workspace, {
      title: "Collect Workspace feedback",
      content: "Collect feedback from both collaborators.",
      due_at: new Date(Date.now() + 60_000).toISOString(),
      child_done_criteria: "Each participant submits a feedback artifact.",
      origin_ref: "test:workspace-feedback",
      assignees: [
        { name: "Zac", agent_id: "zac-agent", content: "Review as Zac.", done_criteria: "Zac artifact exists." },
        { name: "Vivi", agent_id: "vivi-agent", content: "Review as Vivi.", done_criteria: "Vivi artifact exists." }
      ]
    });
    assert.equal(result.parent.task_role, "coordinator");
    assert.equal(result.children.length, 2);
    assert.equal(result.parent.child_task_ids.length, 3);
    assert.equal(result.task_ids.length, 4);
    assert.match(result.parent.done_criteria, /full、partial 或 no_response/);
    assert.deepEqual(
      result.children.map((task) => task.done_criteria),
      ["Zac artifact exists.", "Vivi artifact exists."]
    );
    const queue = JSON.parse(await fs.readFile(taskRegistryPaths(workspace).queuePath, "utf8"));
    assert.deepEqual(queue.map((item) => item.local_task_id).sort(), result.children.map((task) => task.task_id).sort());
    assert.ok(result.parent.task_card_id);
    assert.ok(result.children.every((task) => task.task_card_id));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("fanout validates an explicitly referenced topic", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "task-fanout-topic-"));
  try {
    await assert.rejects(
      createFanoutCollection(workspace, {
        title: "Missing topic",
        content: "Should reject.",
        topic_id: "topic-missing",
        assignees: [{ name: "Zac", agent_id: "zac-agent" }]
      }),
      /topic does not exist/
    );
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("fanout propagates a validated input artifact to every Task Card", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "task-fanout-artifact-"));
  try {
    const topicId = "topic-briefing";
    await fs.mkdir(path.join(workspace, "08-cards", "topics", topicId), { recursive: true });
    await fs.writeFile(path.join(workspace, "08-cards", "topics", topicId, "topic.json"), JSON.stringify({ topic_id: topicId }));
    const artifactPath = "05-agent-outputs/project-hermes/briefing.md";
    const artifactText = "# Briefing\n\n当前进度\n参与者进度\n建议主题\n";
    await fs.mkdir(path.join(workspace, path.dirname(artifactPath)), { recursive: true });
    await fs.writeFile(path.join(workspace, artifactPath), artifactText);
    const artifact = {
      artifact_id: "briefing-test",
      kind: "meeting_briefing",
      title: "Test Briefing",
      path: artifactPath,
      url: "https://example.com/collaborate/05-agent-outputs/project-hermes/briefing.md",
      sha256: createHash("sha256").update(artifactText).digest("hex"),
      required: true
    };
    const result = await createFanoutCollection(workspace, {
      title: "Collect Briefing feedback",
      content: "Review the briefing.",
      topic_id: topicId,
      origin_ref: "topic:topic-briefing",
      input_artifacts: [artifact],
      assignees: [
        { name: "Zac", agent_id: "zac-agent", title: "Zac Briefing feedback" },
        { name: "Vivi", agent_id: "vivi-agent", title: "Vivi Briefing feedback" }
      ]
    });
    const all = [result.parent, result.decomposition, ...result.children];
    assert.ok(all.every((task) => task.input_artifacts?.[0]?.artifact_id === artifact.artifact_id));
    const card = await fs.readFile(path.join(workspace, "08-cards", "cards", `card-${result.children[0].task_card_id}.md`), "utf8");
    assert.match(card, /## 输入材料/);
    assert.match(card, /briefing-test/);
    assert.equal(await validateInputArtifacts(workspace, [artifact]), "");
    await fs.writeFile(path.join(workspace, artifactPath), "changed\n");
    assert.equal(await validateInputArtifacts(workspace, [artifact]), "input_artifact_hash_mismatch:briefing-test");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("fanout defaults its deadline to 72 hours", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "task-fanout-deadline-"));
  try {
    const before = Date.now();
    const result = await createFanoutCollection(workspace, {
      title: "Default deadline",
      content: "Collect feedback.",
      origin_ref: "test:default-deadline",
      assignees: [{ name: "Zac", agent_id: "zac-agent" }]
    });
    const due = Date.parse(result.parent.due_at);
    assert.ok(due >= before + 71 * 60 * 60 * 1000);
    assert.ok(due <= Date.now() + 73 * 60 * 60 * 1000);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("fanout deadline summarizes full, partial, and no response states", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "task-fanout-finalize-"));
  try {
    const result = await createFanoutCollection(workspace, {
      title: "Collect feedback at deadline",
      content: "Collect.",
      due_at: new Date(Date.now() - 1_000).toISOString(),
      done_criteria: "Summarize.",
      origin_ref: "test:deadline-summary",
      assignees: [
        { name: "Zac", agent_id: "zac-agent" },
        { name: "Vivi", agent_id: "vivi-agent" }
      ]
    });
    const childPath = path.join(taskRegistryPaths(workspace).taskRecordsRoot, result.children[0].task_id, "task.json");
    const child = JSON.parse(await fs.readFile(childPath, "utf8"));
    child.status = "completed";
    await fs.writeFile(childPath, JSON.stringify(child, null, 2) + "\n");
    const reconciled = await reconcileFanoutCollections(workspace, { now: Date.now() });
    assert.deepEqual(reconciled.changed, [result.parent.task_id]);
    const parent = JSON.parse(await fs.readFile(path.join(taskRegistryPaths(workspace).taskRecordsRoot, result.parent.task_id, "task.json"), "utf8"));
    assert.equal(parent.status, "completed");
    assert.equal(parent.collection_status, "partial");
    assert.match(parent.summary, /Zac/);
    assert.match(parent.summary, /Vivi/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("fanout refresh preserves the child Task Result instead of restoring task content", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "task-fanout-result-"));
  try {
    const created = await createFanoutCollection(workspace, {
      title: "Collect result feedback",
      content: "Collect feedback from collaborators.",
      due_at: new Date(Date.now() + 60_000).toISOString(),
      origin_ref: "test:fanout-result-preservation",
      assignees: [{ name: "Zac", agent_id: "zac-agent", content: "Submit feedback." }]
    });
    const child = created.children[0];
    const persisted = await persistTaskResult(workspace, child, {
      relay_task_id: "relay-fanout-result",
      source_message_id: "msg-fanout-result",
      submitted_by: "zac-agent",
      submitted_text: "这是 Zac 的完整反馈，不应被原始任务内容覆盖。",
      summary: "收到完整反馈。",
      summary_points: ["收到完整反馈。"]
    });
    child.status = "completed";
    child.latest_result_id = persisted.result.result_id;
    child.latest_result_path = persisted.result_path;
    child.latest_result_markdown_path = persisted.markdown_path;
    child.result_ids = [persisted.result.result_id];
    child.result_summary_points = persisted.result.summary_points;
    child.updated_at = new Date().toISOString();
    await fs.writeFile(
      path.join(taskRegistryPaths(workspace).taskRecordsRoot, child.task_id, "task.json"),
      JSON.stringify(child, null, 2) + "\n"
    );

    await reconcileFanoutCollections(workspace, { now: Date.now() });
    const card = await fs.readFile(path.join(workspace, "08-cards", "cards", `card-${child.task_card_id}.md`), "utf8");
    assert.match(card, /这是 Zac 的完整反馈，不应被原始任务内容覆盖/);
    assert.doesNotMatch(card, /## 完整提交内容\n[^]*Collect feedback from collaborators\./);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
