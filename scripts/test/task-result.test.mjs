import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  persistTaskResult,
  renderTaskCard,
  stableResultId
} from "../task-result.mjs";

test("Task Result persists full feedback on a cold Task directory and is idempotent", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "task-result-"));
  const task = {
    task_id: "task-result-test",
    task_card_id: "card-result-test",
    title: "Review the briefing",
    content: "Submit review feedback.",
    task_kind: "topic_task",
    task_role: "assignee",
    status: "completed",
    owner: "Zac",
    topic_id: "topic-test",
    created_at: "2026-08-17T00:00:00.000Z",
    updated_at: "2026-08-17T01:00:00.000Z",
    done_criteria: "Feedback is submitted."
  };
  const input = {
    relay_task_id: "task_relay-result-test",
    source_message_id: "msg_result-test",
    submitted_by: "zac-agent",
    submitted_at: "2026-08-17T01:00:00.000Z",
    result_type: "mixed",
    submitted_text: "完整反馈：Briefing 的主线基本准确，但会议重点需要调整。\n\n建议先验证 Memory 的实际使用。",
    summary: "Briefing 评审完成，提出了重点调整建议。",
    summary_points: ["Briefing 主线基本准确，但只能部分通过。", "会议应聚焦 Memory 的实际使用验证。"],
    verification: ["已对照 Topic 和当前 Task 状态。"],
    blockers: [],
    artifact_refs: [{ artifact_id: "artifact-review", title: "Review notes", path: "05-agent-outputs/review.md" }]
  };
  try {
    const first = await persistTaskResult(workspace, task, input);
    assert.equal(first.deduplicated, false);
    assert.match(first.result_path, /09-tasks\/tasks\/task-result-test\/results\/result-/);
    assert.equal(first.result.submitted_text, input.submitted_text);
    assert.equal(first.result.artifact_refs[0].artifact_id, "artifact-review");

    const jsonPath = path.join(workspace, first.result_path);
    const markdownPath = path.join(workspace, first.markdown_path);
    assert.equal((await fs.readdir(path.dirname(jsonPath))).length, 2);
    assert.match(await fs.readFile(markdownPath, "utf8"), /完整反馈：Briefing/);

    await fs.rm(markdownPath);
    const replay = await persistTaskResult(workspace, task, {
      ...input,
      submitted_text: "这次重放不应覆盖原始反馈。"
    });
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.result.submitted_text, input.submitted_text);
    assert.match(await fs.readFile(markdownPath, "utf8"), /完整反馈：Briefing/);

    task.latest_result_path = first.result_path;
    const cardPath = await renderTaskCard(workspace, task, { auditEntries: [] });
    const card = await fs.readFile(cardPath, "utf8");
    assert.match(card, /## 完整提交内容\n完整反馈：Briefing/);
    assert.match(card, /artifact-review/);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("Task Result IDs distinguish different Relay messages", () => {
  const first = stableResultId({ taskId: "task-a", relayTaskId: "relay-a", sourceMessageId: "msg-1", summary: "same" });
  const second = stableResultId({ taskId: "task-a", relayTaskId: "relay-a", sourceMessageId: "msg-2", summary: "same" });
  assert.notEqual(first, second);
});
