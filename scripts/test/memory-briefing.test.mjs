import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";

test("meeting briefing uses current progress, human participants, and at most two suggested topics", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "memory-briefing-"));
  try {
    await makeBriefingWorkspace(workspace);
    const output = path.join(workspace, "briefing.md");
    const result = await run(path.resolve(new URL("../generate-meeting-briefing.mjs", import.meta.url).pathname), workspace, [
      "--participants", "Zac,Vivi",
      "--output", "briefing.md"
    ]);
    assert.equal(result.code, 0, result.stderr);
    const markdown = await fs.readFile(output, "utf8");
    assert.match(markdown, /## 当前进度/);
    assert.match(markdown, /## 参与者进度/);
    assert.match(markdown, /## 建议主题/);
    assert.equal(markdown.includes("上次聊到哪里"), false);
    const json = JSON.parse(await fs.readFile(path.join(workspace, "briefing.json"), "utf8"));
    assert.equal(json.participant_progress.length, 2);
    assert.ok(json.participant_progress.every((item) => ["Zac", "Vivi"].includes(item.person)));
    assert.ok(json.suggested_topics.length <= 2);
    assert.equal(json.participant_progress.some((item) => item.person === "Hermes"), false);
    assert.deepEqual(json.suggested_topics.map((item) => item.question), [
      "Hermes Memory 使用正确性保障",
      "Hermes Memory 使用验证测试设计"
    ]);
    assert.ok(json.suggested_topics.every((item) => item.source_refs.includes("09-tasks/tasks/task-review/results/result-review.json")));
    assert.equal(JSON.stringify(json.participant_progress).includes("Briefing review workflow"), false);
    assert.equal(JSON.stringify(json.participant_progress).includes("NO_TASK notification"), false);
    assert.ok(json.current_progress.summary.includes("实时索引显示"));
    assert.ok(json.current_progress.active_tasks.some((task) => task.task_id === "task-vivi"));
    assert.equal(json.current_progress.active_topics.some((topic) => topic.topic_kind === "briefing"), false);
    assert.ok(json.current_progress.warnings.some((warning) => warning.includes("以实时索引为准")));
    const appliedCorrection = json.memory_application.find((item) => item.memory_ref.endsWith("pdca-4-stale-project-state.md"));
    assert.equal(appliedCorrection.status, "applied");
    assert.deepEqual(appliedCorrection.affected_sections, ["current_progress"]);
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

async function makeBriefingWorkspace(workspace) {
  await fs.mkdir(path.join(workspace, "10-memory", "people"), { recursive: true });
  await fs.mkdir(path.join(workspace, "10-memory", "consensus"), { recursive: true });
  await fs.mkdir(path.join(workspace, "10-memory", "methods"), { recursive: true });
  await fs.mkdir(path.join(workspace, "10-memory", "corrections"), { recursive: true });
  await fs.mkdir(path.join(workspace, "10-memory", "project"), { recursive: true });
  await fs.writeFile(path.join(workspace, "source.md"), "source\n");
  for (const [relative, person] of [["people/zac.md", "Zac"], ["people/vivi.md", "Vivi"]]) {
    await fs.writeFile(path.join(workspace, "10-memory", relative), memoryFile(`memory-${person.toLowerCase()}`, "person_profile", `person: ${person}`));
  }
  await fs.writeFile(path.join(workspace, "10-memory", "project/context.md"), memoryFile("memory-project", "project_context", ""));
  await fs.writeFile(path.join(workspace, "10-memory", "consensus/index.md"), memoryFile("memory-consensus", "consensus_index", ""));
  await fs.writeFile(path.join(workspace, "10-memory", "methods/index.md"), memoryFile("memory-methods", "methods_index", ""));
  await fs.writeFile(path.join(workspace, "10-memory", "corrections/index.md"), memoryFile("memory-corrections", "corrections_index", ""));
  await fs.writeFile(path.join(workspace, "10-memory", "corrections/pdca-4-stale-project-state.md"), [
    "---",
    "memory_id: correction-memory-pdca-4-stale-project-state",
    "memory_type: correction",
    "title: 纠正动态索引与项目状态不同步",
    "status: active",
    "fact_status: confirmed",
    "evidence_type: human_correction",
    "applies_to_actions: [meeting_briefing]",
    "source_refs:",
    "  - source.md",
    "---",
    "",
    "实时状态以动态索引为准，并明确标注与历史项目状态的差异。",
    ""
  ].join("\n"));
  await fs.mkdir(path.join(workspace, "08-cards"), { recursive: true });
  await fs.mkdir(path.join(workspace, "09-tasks"), { recursive: true });
  const resultPath = "09-tasks/tasks/task-review/results/result-review.json";
  await writeJson(path.join(workspace, resultPath), {
    result_id: "result-review",
    acceptance_status: "accepted",
    submitted_text: "建议会议 Topic 1\n\n标题：\n\nHermes Memory 使用正确性保障\n\n建议会议 Topic 2\n\n标题：\n\nHermes Memory 使用验证测试设计",
    summary_points: ["Briefing 评审已完成。"]
  });
  const tasks = [
    { task_id: "task-vivi", owner: "Vivi", status: "processing", title: "Vivi task", updated_at: "2026-08-13T02:00:00Z", task_path: "09-tasks/tasks/task-vivi/task.json" },
    {
      task_id: "task-review", owner: "Zac", status: "completed", task_kind: "fanout_child",
      title: "Briefing review workflow", updated_at: "2026-08-17T02:00:00Z",
      latest_result_path: resultPath, latest_result_markdown_path: "09-tasks/tasks/task-review/results/result-review.md",
      task_path: "09-tasks/tasks/task-review/task.json", input_artifacts: [{ kind: "meeting_briefing" }]
    },
    { task_id: "task-noop", owner: "Zac", status: "processing", task_kind: "daily_action", action: "NO_TASK", title: "NO_TASK notification", updated_at: "2026-08-17T02:00:00Z" }
  ];
  await writeJson(path.join(workspace, "08-cards/card_index.json"), {
    human_events: [{ human_event_id: "he-test", title: "Test event", occurred_at: "2026-08-13T01:00:00Z", summary: "Zac 确认不创建任何正式 Task，后续由 Project Hermes 处理。", topic_ids: ["topic-test"] }],
    topics: [{ topic_id: "topic-test", title: "Open topic", status: "active", updated_at: "2026-08-13T02:00:00Z", current_summary: "Need review" }],
    cards: [{ card_id: "card-zac", author: "Zac", lifecycle_status: "accepted", occurred_at: "2026-08-13T02:00:00Z", key_points: ["Zac completed review"], card_path: "08-cards/cards/card-zac.md" }],
    tasks
  });
  await writeJson(path.join(workspace, "09-tasks/task_index.json"), { tasks });
}

function memoryFile(id, type, extra) {
  return `---\nmemory_id: ${id}\nmemory_type: ${type}\n${extra ? `${extra}\n` : ""}status: active\nfact_status: confirmed\nevidence_type: authority_pointer\nsource_refs:\n  - source.md\n---\n\nConfirmed navigation.\n`;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

function run(script, cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env, COLLAB_WORKSPACE: cwd }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
