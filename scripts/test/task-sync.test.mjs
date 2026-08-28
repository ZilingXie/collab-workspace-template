import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const syncPath = path.join(scriptsDirectory, "task-sync.mjs");

test("completing a Topic Task updates its Task Card without creating a Hermes Personal Card", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "task-sync-card-"));
  const taskId = "task-sync1234";
  const taskCardId = "taskcard1234";
  try {
    await fs.mkdir(path.join(workspace, "09-tasks", "tasks", taskId), { recursive: true });
    await fs.mkdir(path.join(workspace, "08-cards", "cards"), { recursive: true });
    await fs.mkdir(path.join(workspace, "08-cards", "contents"), { recursive: true });
    await fs.writeFile(path.join(workspace, "09-tasks", "dispatch_queue.json"), "[]\n");
    await fs.writeFile(path.join(workspace, "09-tasks", "tasks", taskId, "audit.jsonl"), "");
    await fs.writeFile(path.join(workspace, "09-tasks", "tasks", taskId, "task.json"), JSON.stringify({
      task_id: taskId,
      task_kind: "topic_task",
      task_card_id: taskCardId,
      title: "Track this Task",
      content: "Implement the agreed change.",
      owner: "Zac Codex",
      status: "processing",
      topic_id: "topic-test",
      human_event_ids: ["he-test"],
      done_criteria: "The artifact exists.",
      created_at: "2026-08-12T00:00:00.000Z",
      updated_at: "2026-08-12T00:00:00.000Z"
    }, null, 2) + "\n");
    await run(syncPath, workspace, ["--task-id", taskId, "--status", "completed", "--summary", "Verified complete."]);
    const task = JSON.parse(await fs.readFile(path.join(workspace, "09-tasks", "tasks", taskId, "task.json"), "utf8"));
    const files = await fs.readdir(path.join(workspace, "08-cards", "cards"));
    const card = await fs.readFile(path.join(workspace, "08-cards", "cards", `card-${taskCardId}.md`), "utf8");
    assert.equal(task.status, "completed");
    assert.equal(task.completion_card_id, undefined);
    assert.deepEqual(files, [`card-${taskCardId}.md`]);
    assert.match(card, /## 当前状态\n- 完成/);
    assert.match(card, /## 结果摘要\n- Verified complete\./);
    assert.match(card, /## 完整提交内容\nVerified complete\./);
    assert.match(card, /## Result 来源\n- 09-tasks\/tasks\/task-sync1234\/results\/result-/);
    assert.ok(task.latest_result_id);
    assert.equal(task.result_summary_points[0], "Verified complete.");
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("task-sync preserves full inline feedback, artifacts, and same-message idempotency", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "task-sync-result-"));
  const taskId = "task-sync-result1";
  const taskCardId = "taskcard-result1";
  const taskDirectory = path.join(workspace, "09-tasks", "tasks", taskId);
  const envelopePath = path.join(workspace, ".hermes", "result-envelopes", "reply.json");
  const submittedText = "Zac 的完整反馈：Briefing 主线基本准确，但当前会议重点需要调整。\n\n建议验证 Memory 的实际使用。";
  try {
    await fs.mkdir(taskDirectory, { recursive: true });
    await fs.mkdir(path.join(workspace, "08-cards", "cards"), { recursive: true });
    await fs.writeFile(path.join(workspace, "09-tasks", "dispatch_queue.json"), "[]\n");
    await fs.writeFile(path.join(taskDirectory, "audit.jsonl"), "");
    await fs.writeFile(path.join(taskDirectory, "task.json"), JSON.stringify({
      task_id: taskId,
      task_kind: "fanout_child",
      task_role: "assignee",
      task_card_id: taskCardId,
      title: "Zac 的 Briefing 反馈",
      content: "请提交反馈。",
      owner: "Zac",
      status: "processing",
      topic_id: "topic-result",
      human_event_ids: [],
      done_criteria: "提交反馈。",
      created_at: "2026-08-14T00:00:00.000Z",
      updated_at: "2026-08-14T00:00:00.000Z",
      parent_task_id: null,
      child_task_ids: []
    }, null, 2) + "\n");
    await fs.mkdir(path.dirname(envelopePath), { recursive: true });
    await fs.writeFile(envelopePath, JSON.stringify({
      schema_version: 1,
      task_id: taskId,
      relay_task_id: "relay-result1",
      source_message_id: "msg-result1",
      submitted_by: "zac-agent",
      submitted_at: "2026-08-17T01:00:00.000Z",
      result_type: "mixed",
      submitted_text: submittedText,
      summary: "Briefing 评审完成。",
      summary_points: ["Briefing 主线基本准确，但只能部分通过。", "会议应验证 Memory 的实际使用。"],
      verification: ["已对照当前 Topic。"],
      blockers: ["缺少 Memory 使用审计。"],
      artifact_refs: [{ artifact_id: "artifact-zac", title: "Zac feedback", path: "05-agent-outputs/zac-feedback.md" }]
    }, null, 2) + "\n");

    await run(syncPath, workspace, [
      "--task-id", taskId,
      "--status", "completed",
      "--relay-task-id", "relay-result1",
      "--result-file", envelopePath
    ]);
    const firstTask = JSON.parse(await fs.readFile(path.join(taskDirectory, "task.json"), "utf8"));
    const firstCard = await fs.readFile(path.join(workspace, "08-cards", "cards", `card-${taskCardId}.md`), "utf8");
    assert.equal(firstTask.status, "completed");
    assert.equal(firstTask.result_ids.length, 1);
    assert.equal(firstTask.result_summary_points[0], "Briefing 主线基本准确，但只能部分通过。");
    assert.match(firstCard, /## 完整提交内容\nZac 的完整反馈：Briefing 主线基本准确/);
    assert.match(firstCard, /artifact-zac/);
    assert.match(firstCard, /缺少 Memory 使用审计/);

    await run(syncPath, workspace, [
      "--task-id", taskId,
      "--status", "completed",
      "--relay-task-id", "relay-result1",
      "--result-file", envelopePath
    ]);
    const secondTask = JSON.parse(await fs.readFile(path.join(taskDirectory, "task.json"), "utf8"));
    const resultFiles = (await fs.readdir(path.join(taskDirectory, "results"))).filter((file) => file.endsWith(".json"));
    const audit = (await fs.readFile(path.join(taskDirectory, "audit.jsonl"), "utf8"))
      .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(secondTask.result_ids.length, 1);
    assert.equal(resultFiles.length, 1);
    assert.equal(audit.filter((entry) => entry.type === "result_received").length, 2);
    assert.deepEqual(audit.map((entry) => entry.type), [
      "result_received",
      "completed",
      "result_accepted",
      "result_received",
      "result_accepted"
    ]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("task-sync rejects a Result Envelope outside the workspace or configured result root", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "task-sync-result-security-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "task-sync-outside-"));
  const taskId = "task-sync-security";
  try {
    const taskDirectory = path.join(workspace, "09-tasks", "tasks", taskId);
    await fs.mkdir(taskDirectory, { recursive: true });
    await fs.mkdir(path.join(workspace, "08-cards", "cards"), { recursive: true });
    await fs.writeFile(path.join(workspace, "09-tasks", "dispatch_queue.json"), "[]\n");
    await fs.writeFile(path.join(taskDirectory, "audit.jsonl"), "");
    await fs.writeFile(path.join(taskDirectory, "task.json"), JSON.stringify({
      task_id: taskId,
      task_kind: "topic_task",
      task_card_id: "taskcard-security",
      title: "Security test",
      content: "Do not accept outside result.",
      status: "processing",
      owner: "Zac",
      done_criteria: "Evidence.",
      created_at: "2026-08-17T00:00:00.000Z",
      updated_at: "2026-08-17T00:00:00.000Z"
    }, null, 2) + "\n");
    const outsidePath = path.join(outside, "result.json");
    await fs.writeFile(outsidePath, JSON.stringify({ submitted_text: "should not be read" }));
    await assert.rejects(
      run(syncPath, workspace, ["--task-id", taskId, "--status", "completed", "--result-file", outsidePath]),
      /outside the allowed result envelope roots/
    );
    const task = JSON.parse(await fs.readFile(path.join(taskDirectory, "task.json"), "utf8"));
    assert.equal(task.status, "processing");
    await assert.rejects(fs.access(path.join(taskDirectory, "results")));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

function run(script, workspace, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: workspace,
      env: { ...process.env, COLLAB_WORKSPACE: workspace },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}
