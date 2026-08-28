import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const routerPath = path.resolve("scripts/hermes-draft-router.mjs");

test("unbound draft creates a Human Event, Hermes Card, submitter Card, and missing-author task", async () => {
  const workspace = await makeWorkspace("zac-draft");
  await writeDraft(workspace, "zac-draft", "meeting.md");
  const result = await runRouter(workspace, {
    route: "human_event",
    event_type: "meeting",
    event_title: "测试会议",
    title: "Zac 的会议判断",
    occurred_at: "2026-08-04T01:30:00.000Z",
    participants: ["Zac", "Vivi"],
    summary: "测试 Human Event 总结。",
    key_points: ["形成测试共识。"],
    candidate_topics: [{ title: "测试 Topic", summary: "测试 Topic 总结。" }],
    candidate_tasks: []
  });
  assert.equal(result.code, 0, result.stderr);

  const events = await jsonFiles(path.join(workspace, "08-cards", "human-events", "records"), "event.json");
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.personal_card_ids.length, 2);
  assert.equal(event.card_collection_deadline_at, null);

  const cards = await markdownFiles(path.join(workspace, "08-cards", "cards"));
  assert.equal(cards.length, 2);
  const review = (await jsonFiles(path.join(workspace, "08-cards", "human-events", "records"), "review.json"))[0];
  assert.equal(review.card_submission_task_ids.length, 2);
  const tasks = await jsonFiles(path.join(workspace, "09-tasks", "tasks"), "task.json");
  assert.equal(tasks.filter((task) => task.task_kind === "card_submission" && task.status === "completed").length, 1);
  const pendingSubmission = tasks.find((task) => task.task_kind === "card_submission" && task.status === "ready");
  assert.equal(pendingSubmission.title, "提交交流记录卡片：测试会议");
  assert.match(pendingSubmission.content, new RegExp(event.human_event_id));
  assert.match(pendingSubmission.content, /vivi-draft/);
  assert.equal((await readJson(path.join(workspace, "09-tasks", "dispatch_queue.json"))).filter((item) => item.status === "pending").length, 1);
});

test("standalone draft creates a Topic and Personal Card without a Human Event", async () => {
  const workspace = await makeWorkspace("vivi-draft");
  await writeDraft(workspace, "vivi-draft", "topic.md");
  const result = await runRouter(workspace, {
    route: "topic",
    topic_title: "测试独立 Topic",
    title: "Vivi 的 Topic 更新",
    occurred_at: "2026-08-04T02:00:00.000Z",
    participants: ["Vivi"],
    summary: "测试 Topic 更新。",
    key_points: ["完成一项 Topic 观察。"]
  });
  assert.equal(result.code, 0, result.stderr);
  const topics = await jsonFiles(path.join(workspace, "08-cards", "topics"), "topic.json");
  assert.equal(topics.length, 1);
  assert.equal(topics[0].personal_card_ids.length, 1);
  assert.equal((await jsonFiles(path.join(workspace, "08-cards", "human-events", "records"), "event.json")).length, 0);
});

test("ambiguous draft creates a clarification review and a task for its submitter", async () => {
  const workspace = await makeWorkspace("zac-draft");
  await writeDraft(workspace, "zac-draft", "ambiguous.md");
  const result = await runRouter(workspace, { route: "review", title: "待确认材料", uncertainty_reason: "有多个候选归属。" });
  assert.equal(result.code, 0, result.stderr);
  const reviews = await jsonFiles(path.join(workspace, "08-cards", "review"), "review.json");
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].review_kind, "draft_routing");
  const tasks = await jsonFiles(path.join(workspace, "09-tasks", "tasks"), "task.json");
  assert.equal(tasks[0].task_kind, "draft_routing_clarification");
  assert.equal(reviews[0].submitted_by, "zac");
  assert.equal(reviews[0].owner, "Zac");
  assert.equal(tasks[0].owner, "Zac");
  assert.equal(tasks[0].owner_agent_id, "zac-agent");
  assert.equal(tasks[0].task_role, "manager_review");
});

test("ambiguous Flash routing falls back to Pro before creating a review", async () => {
  const workspace = await makeWorkspace("zac-draft");
  await writeDraft(workspace, "zac-draft", "fallback.md");
  const fakeHermes = await writeFakeHermes(workspace);
  const result = await runRouterWithModels(workspace, fakeHermes);
  assert.equal(result.code, 0, result.stderr);
  const events = await jsonFiles(path.join(workspace, "08-cards", "human-events", "records"), "event.json");
  assert.equal(events.length, 1);
  const intakes = await jsonFiles(path.join(workspace, "08-cards", "draft-routing", "processing"), "intake.json");
  assert.equal(intakes.length, 1);
  assert.equal(intakes[0].model_diagnostics.primary_model, "deepseek-v4-flash");
  assert.equal(intakes[0].model_diagnostics.final_model, "deepseek-v4-pro");
  assert.equal(intakes[0].model_diagnostics.fallback_reason, "ambiguous_route_requires_decision_model");
  assert.deepEqual((await fs.readFile(path.join(workspace, "model-calls.log"), "utf8")).trim().split("\n"), ["deepseek-v4-flash", "deepseek-v4-pro"]);
});

async function makeWorkspace(owner) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "draft-router-"));
  await fs.mkdir(path.join(workspace, "08-cards", "inbox", owner), { recursive: true });
  return workspace;
}

async function writeDraft(workspace, owner, name) {
  await fs.writeFile(path.join(workspace, "08-cards", "inbox", owner, name), "---\ntitle: Test draft\n---\n\n# Test draft\n\nA submitted draft.\n", "utf8");
}

function runRouter(workspace, proposal) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [routerPath], {
      cwd: path.dirname(routerPath),
      env: { ...process.env, COLLAB_WORKSPACE: workspace, PROJECT_HERMES_CONFIG: path.join(workspace, "missing-config.yaml"), PROJECT_HERMES_DRAFT_TEST_PROPOSAL_JSON: JSON.stringify(proposal) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function runRouterWithModels(workspace, hermesCommand) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [routerPath], {
      cwd: path.dirname(routerPath),
      env: { ...process.env, COLLAB_WORKSPACE: workspace, PROJECT_HERMES_CONFIG: path.join(workspace, "missing-config.yaml"), PROJECT_HERMES_COMMAND: hermesCommand, FAKE_MODEL_LOG: path.join(workspace, "model-calls.log") },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function writeFakeHermes(workspace) {
  const file = path.join(workspace, "fake-hermes.sh");
  await fs.writeFile(file, `#!/usr/bin/env bash
set -eu
model=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--model" ]]; then model="$2"; shift 2; else shift; fi
done
printf '%s\\n' "$model" >> "$FAKE_MODEL_LOG"
if [[ "$model" == "deepseek-v4-flash" ]]; then
  printf '%s\\n' '{"route":"review","title":"待确认材料","uncertainty_reason":"多个候选归属"}'
else
  printf '%s\\n' '{"route":"human_event","event_type":"meeting","event_title":"Pro 确认的会议","title":"Zac 的会议判断","occurred_at":"2026-08-05T01:00:00.000Z","participants":["Zac","Vivi"],"summary":"Pro 完成归属判断。","key_points":["归属明确。"],"candidate_topics":[],"candidate_tasks":[]}'
fi
`);
  await fs.chmod(file, 0o755);
  return file;
}

async function jsonFiles(root, basename) {
  const out = [];
  await walk(root, async (filePath) => {
    if (path.basename(filePath) === basename) out.push(await readJson(filePath));
  });
  return out;
}

async function markdownFiles(root) {
  const out = [];
  await walk(root, async (filePath) => {
    if (filePath.endsWith(".md")) out.push(filePath);
  });
  return out;
}

async function walk(root, visit) {
  let entries = [];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) await walk(filePath, visit);
    else await visit(filePath);
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}
