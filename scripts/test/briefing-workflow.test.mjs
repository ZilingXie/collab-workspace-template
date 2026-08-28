import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureBriefingReviewSnapshot,
  createDirectBriefing,
  createReviewedBriefing,
  reconcileBriefing
} from "../briefing-workflow.mjs";

test("reviewed briefing creates a new Topic, draft Hermes Card, and participant review tasks", async () => {
  const workspace = await makeWorkspace();
  try {
    const result = await createReviewedBriefing(workspace, {
      request_message_id: "wecom-review-1",
      meeting_date: "2026-08-18",
      meeting_goal: "验证标准 Briefing 流程",
      participants: ["Zac", "Vivi"]
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, "reviewed");
    assert.equal(result.briefing.status, "review_collecting");
    assert.equal(result.briefing.draft_card_id.length, 16);
    assert.equal(result.briefing.review_task_ids.length, 2);
    const topic = JSON.parse(await fs.readFile(path.join(workspace, "08-cards", "topics", result.briefing.topic_id, "topic.json"), "utf8"));
    assert.deepEqual(topic.human_event_ids, []);
    assert.deepEqual(topic.personal_card_ids, [result.briefing.draft_card_id]);
    assert.ok(result.briefing.current_progress?.summary);
    assert.ok(result.briefing.required_sections.includes("当前进度"));
    const draftCard = await fs.readFile(path.join(workspace, "08-cards", "cards", `card-${result.briefing.draft_card_id}.md`), "utf8");
    assert.match(draftCard, /key_points:\n  - /);
    assert.equal((await fs.readdir(path.join(workspace, "05-agent-outputs", "project-hermes", "meeting-briefings"))).some((name) => name.endsWith(".md")), true);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("direct briefing creates only a final file and no Personal Card or review task", async () => {
  const workspace = await makeWorkspace();
  try {
    const result = await createDirectBriefing(workspace, {
      request_message_id: "wecom-direct-1",
      meeting_date: "2026-08-18",
      meeting_goal: "临时会议",
      participants: ["Zac", "Vivi"]
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, "direct");
    assert.equal(result.briefing.status, "finalized_direct");
    assert.equal(result.briefing.draft_card_id, null);
    assert.equal(result.briefing.review_task_ids, undefined);
    assert.match(result.briefing.final_path, /-final\.md$/);
    assert.ok(result.briefing.summary_points.length >= 1);
    const topic = JSON.parse(await fs.readFile(path.join(workspace, "08-cards", "topics", result.briefing.topic_id, "topic.json"), "utf8"));
    assert.equal(topic.current_summary, result.briefing.summary_points[0]);
    assert.deepEqual(topic.personal_card_ids, []);
    const cards = await fs.readdir(path.join(workspace, "08-cards", "cards"));
    assert.deepEqual(cards, []);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("direct briefing is idempotent by request message id", async () => {
  const workspace = await makeWorkspace();
  try {
    const input = {
      request_message_id: "wecom-direct-idempotent",
      meeting_goal: "验证请求幂等",
      participants: ["Zac", "Vivi"]
    };
    const first = await createDirectBriefing(workspace, input);
    const second = await createDirectBriefing(workspace, input);
    assert.equal(second.deduplicated, true);
    assert.equal(second.briefing.briefing_id, first.briefing.briefing_id);
    assert.equal(second.briefing.topic_id, first.briefing.topic_id);
    const topics = await fs.readdir(path.join(workspace, "08-cards", "topics"));
    assert.deepEqual(topics, [first.briefing.topic_id]);
    const metadataFiles = (await fs.readdir(path.join(workspace, "05-agent-outputs", "project-hermes", "meeting-briefings")))
      .filter((name) => name.endsWith(".json"));
    assert.deepEqual(metadataFiles, [`${first.briefing.briefing_id}.json`]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("all reviewed children complete early and generate one final briefing", async () => {
  const workspace = await makeWorkspace();
  try {
    const created = await createReviewedBriefing(workspace, {
      request_message_id: "wecom-review-2",
      meeting_goal: "提前收敛",
      participants: ["Zac", "Vivi"]
    });
    for (const [index, taskId] of created.briefing.review_task_ids.entries()) {
      const taskPath = path.join(workspace, "09-tasks", "tasks", taskId, "task.json");
      const task = JSON.parse(await fs.readFile(taskPath, "utf8"));
      task.status = "completed";
      task.completed_at = new Date().toISOString();
      task.completion_summary = `${task.owner} 已完成 Briefing 评审 ${index + 1}`;
      await fs.writeFile(taskPath, JSON.stringify(task, null, 2) + "\n");
      await captureBriefingReviewSnapshot(workspace, taskId, task.completion_summary, `relay-${index}`);
    }
    const finalized = await reconcileBriefing(workspace, { briefing_id: created.briefing.briefing_id });
    assert.equal(finalized.briefing.status, "finalized_full");
    assert.equal(finalized.briefing.review_coverage.completed, 2);
    const metadataPath = path.join(workspace, "05-agent-outputs", "project-hermes", "meeting-briefings", `${created.briefing.briefing_id}.json`);
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    assert.equal(metadata.final_path, finalized.briefing.final_path);
    assert.equal((await fs.readFile(path.join(workspace, finalized.briefing.final_path), "utf8")).includes("最终会前简报"), true);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

async function makeWorkspace() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "briefing-workflow-test-"));
  for (const directory of [
    "08-cards/topics",
    "08-cards/cards",
    "08-cards/contents",
    "08-cards/human-events/records",
    "09-tasks/tasks",
    "05-agent-outputs/project-hermes/meeting-briefings",
    "10-memory"
  ]) await fs.mkdir(path.join(workspace, directory), { recursive: true });
  await fs.writeFile(path.join(workspace, "09-tasks", "dispatch_queue.json"), "[]\n");
  await fs.writeFile(path.join(workspace, "08-cards", "card_index.json"), JSON.stringify({ schema_version: 3, cards: [], topics: [], human_events: [], tasks: [] }) + "\n");
  await fs.writeFile(path.join(workspace, "10-memory", "memory-index.json"), JSON.stringify({ memory: [] }) + "\n");
  return workspace;
}
