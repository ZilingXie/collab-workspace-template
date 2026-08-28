import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptsDirectory = path.resolve(testDirectory, "..");
const pipelinePath = path.join(scriptsDirectory, "human-event-pipeline.mjs");
const cardIngestPath = path.join(scriptsDirectory, "hermes-card-ingest.mjs");
const validatorPath = path.join(scriptsDirectory, "validate-card-submission.mjs");

const proposal = {
  title: "Chat Human Event",
  occurred_at: "2026-08-03T01:00:00.000Z",
  participants: ["Zac", "Vivi"],
  summary: "Initial chat summary.",
  key_points: ["The project direction changed."],
  topics: [{ title: "Shared Topic", summary: "Initial topic summary." }],
  tasks: [{
    title: "Implement shared action",
    content: "Produce the agreed artifact.",
    topic_title: "Shared Topic",
    owner: "Zac Codex",
    done_criteria: "Artifact exists and tests pass.",
    due_date: null,
    risk_level: "L1"
  }]
};

test("Human Event proposal accepts valid stdout JSON", async () => {
  const workspace = await createWorkspace();
  try {
    const hermes = await writeFakeHermes(workspace);
    await runScript(pipelinePath, workspace, {
      PROJECT_HERMES_COMMAND: hermes,
      FAKE_HERMES_MODE: "stdout",
      FAKE_HERMES_PROPOSAL: JSON.stringify(proposal)
    });
    const { event } = await loadOnlyEvent(workspace);
    assert.equal(event.title, proposal.title);
    const intake = await loadOnlyIntake(workspace);
    assert.equal(intake.proposal_diagnostics.primary_model, "deepseek-v4-flash");
    assert.equal(intake.proposal_diagnostics.final_model, "deepseek-v4-flash");
    assert.equal(intake.proposal_diagnostics.first_run.model, "deepseek-v4-flash");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Analysis Package v2 pointer creates a Human Event without moving the raw source", async () => {
  const workspace = await createWorkspace();
  try {
    await rm(path.join(workspace, "08-cards", "human-events", "inbox", "chat", "chat.txt"), { force: true });
    const ingestId = "ing-v2-test";
    const rawPath = path.join(workspace, "01-raw", "intakes", ingestId, "source.txt");
    const analysisPath = path.join(workspace, "02-notes", "intakes", ingestId, "analysis.json");
    const pointerPath = path.join(workspace, "08-cards", "human-events", "inbox", "chat", `${ingestId}.json`);
    await mkdir(path.dirname(rawPath), { recursive: true });
    await mkdir(path.dirname(analysisPath), { recursive: true });
    await mkdir(path.dirname(pointerPath), { recursive: true });
    await writeFile(rawPath, "v2 source\n");
    await writeFile(analysisPath, JSON.stringify({
      schema_version: 2,
      ingest_id: ingestId,
      source_ref: `01-raw/intakes/${ingestId}/source.txt`,
      signal_analysis: { facts: ["Confirmed"], speculations: [], unknowns: [], risks: [], actions: [], noise: [] },
      human_event: { title: "V2 Human Event", summary_points: ["V2 package was received."], participants: ["Zac", "Vivi"], occurred_at: "2026-08-12T00:00:00.000Z" },
      topic_candidates: [],
      task_candidates: [],
      person_candidates: [],
      dictionary_candidates: [],
      method_candidates: [{ title: "V2 method", summary: "A candidate method.", source_refs: [`01-raw/intakes/${ingestId}/source.txt`] }],
      decision_candidates: [],
      memory_proposals: [],
      uncertainties: [],
      evidence_refs: [`01-raw/intakes/${ingestId}/source.txt`]
    }, null, 2));
    await writeFile(pointerPath, JSON.stringify({
      schema_version: 2,
      ingest_id: ingestId,
      human_event_type: "chat",
      original_filename: "source.txt",
      source_path: `01-raw/intakes/${ingestId}/source.txt`,
      analysis_path: `02-notes/intakes/${ingestId}/analysis.json`,
      manifest_path: `01-raw/intakes/${ingestId}/manifest.json`,
      status: "queued"
    }));
    await writeJson(path.join(workspace, "01-raw", "intakes", ingestId, "manifest.json"), { schema_version: 2, ingest_id: ingestId, run_id: "test", status: "analyzed" });
    await runScript(pipelinePath, workspace, {}, ["--chat-only"]);
    const { event } = await loadOnlyEvent(workspace);
    assert.equal(event.title, "V2 Human Event");
    assert.equal(event.analysis_ref, `02-notes/intakes/${ingestId}/analysis.json`);
    assert.equal(event.source_refs[0], `01-raw/intakes/${ingestId}/source.txt`);
    assert.equal((await readFile(rawPath, "utf8")), "v2 source\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Human Event proposal falls back to the intake-specific proposal file", async () => {
  const workspace = await createWorkspace();
  try {
    const hermes = await writeFakeHermes(workspace);
    await runScript(pipelinePath, workspace, {
      PROJECT_HERMES_COMMAND: hermes,
      FAKE_HERMES_MODE: "proposal-file",
      FAKE_HERMES_PROPOSAL: JSON.stringify(proposal)
    });
    const intake = await loadOnlyIntake(workspace);
    assert.equal(intake.status, "review");
    assert.ok(intake.proposal_diagnostics.attempts.some((attempt) => attempt.source === "proposal_file" && attempt.ok));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Human Event proposal performs one tool-limited JSON repair", async () => {
  const workspace = await createWorkspace();
  try {
    const hermes = await writeFakeHermes(workspace);
    await runScript(pipelinePath, workspace, {
      PROJECT_HERMES_COMMAND: hermes,
      FAKE_HERMES_MODE: "repair",
      FAKE_HERMES_PROPOSAL: JSON.stringify(proposal)
    });
    const intake = await loadOnlyIntake(workspace);
    assert.ok(intake.proposal_diagnostics.attempts.some((attempt) => attempt.source === "repair_stdout" && attempt.ok));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("invalid stdout, proposal file, and repair output leave detailed retry diagnostics", async () => {
  const workspace = await createWorkspace();
  try {
    const hermes = await writeFakeHermes(workspace);
    await assert.rejects(runScript(pipelinePath, workspace, {
      PROJECT_HERMES_COMMAND: hermes,
      FAKE_HERMES_MODE: "invalid",
      FAKE_HERMES_PROPOSAL: JSON.stringify(proposal)
    }));
    const intake = await loadOnlyIntake(workspace);
    assert.equal(intake.status, "retry");
    assert.match(intake.last_error, /proposal fallback failed/);
    assert.equal(intake.proposal_diagnostics.first_run.code, 0);
    assert.equal(intake.proposal_diagnostics.repair_run.code, 0);
    assert.equal(intake.proposal_diagnostics.fallback_run.model, "deepseek-v4-pro");
    assert.deepEqual(intake.proposal_diagnostics.attempts.map((attempt) => attempt.source), ["stdout", "proposal_file", "repair_stdout", "fallback_stdout", "fallback_proposal_file"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an L2 candidate is re-evaluated by the decision model", async () => {
  const workspace = await createWorkspace();
  try {
    const hermes = await writeFakeHermes(workspace);
    const l2Proposal = { ...proposal, tasks: [{ ...proposal.tasks[0], risk_level: "L2" }] };
    await runScript(pipelinePath, workspace, {
      PROJECT_HERMES_COMMAND: hermes,
      FAKE_HERMES_MODE: "stdout",
      FAKE_HERMES_PROPOSAL: JSON.stringify(l2Proposal)
    });
    const intake = await loadOnlyIntake(workspace);
    assert.equal(intake.proposal_diagnostics.fallback_reason, "l2_candidate_requires_decision_model");
    assert.equal(intake.proposal_diagnostics.final_model, "deepseek-v4-pro");
    assert.equal(intake.proposal_diagnostics.fallback_run.model, "deepseek-v4-pro");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("disabling Flash routes initial extraction directly to Pro", async () => {
  const workspace = await createWorkspace();
  try {
    const hermes = await writeFakeHermes(workspace);
    await runScript(pipelinePath, workspace, {
      PROJECT_HERMES_COMMAND: hermes,
      PROJECT_HERMES_FLASH_ENABLED: "0",
      FAKE_HERMES_MODE: "stdout",
      FAKE_HERMES_PROPOSAL: JSON.stringify(proposal)
    });
    const intake = await loadOnlyIntake(workspace);
    assert.equal(intake.proposal_diagnostics.primary_model, "deepseek-v4-pro");
    assert.equal(intake.proposal_diagnostics.final_model, "deepseek-v4-pro");
    assert.equal(intake.proposal_diagnostics.fallback_reason, null);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("chat creates a provisional Human Event and queues two submission tasks for immediate dispatch", async () => {
  const workspace = await createWorkspace();
  try {
    await runScript(pipelinePath, workspace, { PROJECT_HERMES_EVENT_TEST_PROPOSAL_JSON: JSON.stringify(proposal) });
    const { event, review } = await loadOnlyEvent(workspace);
    const tasks = await loadTasks(workspace);
    const submissionTasks = tasks.filter((task) => task.task_kind === "card_submission");

    assert.equal(event.type, "chat");
    assert.equal(event.summary_status, "provisional");
    assert.equal(event.summary, "Initial chat summary.");
    assert.equal(event.personal_card_ids.length, 1);
    assert.equal(review.status, "pending_cards");
    assert.deepEqual(review.expected_authors, ["hermes", "zac", "vivi"]);
    assert.equal(submissionTasks.length, 2);
    assert.equal(event.card_collection_deadline_at, null);
    assert.ok(submissionTasks.every((task) => task.due_at === null));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("Hermes Personal Card keeps its exchange summary separate from candidate decisions", async () => {
  const workspace = await createWorkspace();
  try {
    await runScript(pipelinePath, workspace, { PROJECT_HERMES_EVENT_TEST_PROPOSAL_JSON: JSON.stringify(proposal) });
    const { event } = await loadOnlyEvent(workspace);
    const cardPath = path.join(workspace, "08-cards", "cards", `card-${event.personal_card_ids[0]}.md`);
    const card = await readFile(cardPath, "utf8");
    assert.match(card, /## Hermes 交流总结/);
    assert.doesNotMatch(card, /## 候选 Topic/);
    assert.doesNotMatch(card, /## 候选 Task/);
    assert.equal(event.candidate_topics.length, 1);
    assert.equal(event.candidate_tasks.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("three cards finalize once and materialize only decisions backed by human card IDs", async () => {
  const workspace = await createWorkspace();
  try {
    await runScript(pipelinePath, workspace, { PROJECT_HERMES_EVENT_TEST_PROPOSAL_JSON: JSON.stringify(proposal) });
    const first = await loadOnlyEvent(workspace);
    await writeHumanCard(workspace, first.event.human_event_id, "zac-card", "Zac", "Zac confirms the Topic and Task.");
    await writeHumanCard(workspace, first.event.human_event_id, "vivi-card", "Vivi", "Vivi confirms the Topic and Task.");
    const finalization = {
      summary: "Final summary from transcript and all three cards.",
      key_points: ["Both people confirmed the implementation."],
      topics: [{
        title: "Shared Topic",
        summary: "Confirmed topic summary.",
        status: "approved",
        reason: "Both human cards confirm it.",
        supporting_card_ids: ["zac-card", "vivi-card"],
        opposing_card_ids: []
      }],
      tasks: [{
        title: "Implement shared action",
        content: "Produce the agreed artifact.",
        topic_title: "Shared Topic",
        owner: "Zac Codex",
        done_criteria: "Artifact exists and tests pass.",
        risk_level: "L1",
        status: "approved",
        reason: "Both human cards confirm it.",
        supporting_card_ids: ["zac-card", "vivi-card"],
        opposing_card_ids: []
      }]
    };
    const env = { PROJECT_HERMES_EVENT_TEST_FINALIZATION_JSON: JSON.stringify(finalization) };
    await runScript(pipelinePath, workspace, env, ["--finalize-only"]);
    await runScript(pipelinePath, workspace, env, ["--finalize-only"]);

    const { event, review } = await loadOnlyEvent(workspace);
    const tasks = await loadTasks(workspace);
    assert.equal(event.summary_status, "final");
    assert.equal(event.summary, finalization.summary);
    assert.equal(event.finalization_reason, "all_cards");
    assert.equal(event.topic_ids.length, 1);
    assert.equal(event.task_ids.length, 1);
    assert.equal(review.status, "finalized");
    assert.deepEqual(review.resolution.topics[0].supporting_card_ids, ["zac-card", "vivi-card"]);
    assert.equal(tasks.filter((task) => task.task_kind === "topic_task").length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("approved fanout candidate materializes coordinator, decomposition, and assignee tasks", async () => {
  const workspace = await createWorkspace();
  try {
    await runScript(pipelinePath, workspace, { PROJECT_HERMES_EVENT_TEST_PROPOSAL_JSON: JSON.stringify(proposal) });
    const initial = await loadOnlyEvent(workspace);
    await writeHumanCard(workspace, initial.event.human_event_id, "zac-fanout-card", "Zac", "Zac supports collecting both reviews.");
    await writeHumanCard(workspace, initial.event.human_event_id, "vivi-fanout-card", "Vivi", "Vivi supports collecting both reviews.");
    const finalization = {
      summary: "Both reviewers will be collected before the deadline.",
      key_points: ["Hermes coordinates; Zac and Vivi provide independent feedback."],
      topics: [{ title: "Shared Topic", summary: "Feedback collection.", status: "approved", supporting_card_ids: ["zac-fanout-card", "vivi-fanout-card"], opposing_card_ids: [] }],
      tasks: [{
        title: "Collect Workspace feedback",
        content: "Collect and summarize feedback from both collaborators.",
        topic_title: "Shared Topic",
        done_criteria: "Parent summary records both child states at the deadline.",
        risk_level: "L1",
        due_date: new Date(Date.now() + 60_000).toISOString(),
        assignees: [
          { name: "Zac", agent_id: "zac-agent", title: "Zac feedback", content: "Review as Zac.", done_criteria: "Zac feedback artifact exists." },
          { name: "Vivi", agent_id: "vivi-agent", title: "Vivi feedback", content: "Review as Vivi.", done_criteria: "Vivi feedback artifact exists." }
        ],
        status: "approved",
        supporting_card_ids: ["zac-fanout-card", "vivi-fanout-card"],
        opposing_card_ids: []
      }]
    };
    await runScript(pipelinePath, workspace, {
      PROJECT_HERMES_EVENT_TEST_FINALIZATION_JSON: JSON.stringify(finalization)
    }, ["--finalize-only"]);
    const tasks = await loadTasks(workspace);
    const parent = tasks.find((task) => task.task_kind === "fanout_collection");
    const decomposition = tasks.find((task) => task.task_kind === "fanout_decomposition");
    const children = tasks.filter((task) => task.task_kind === "fanout_child");
    assert.ok(parent);
    assert.ok(decomposition);
    assert.equal(children.length, 2);
    assert.deepEqual(parent.assignee_task_ids.sort(), children.map((task) => task.task_id).sort());
    assert.equal(parent.child_task_ids.length, 3);
    assert.deepEqual(decomposition.assignee_task_ids.sort(), parent.assignee_task_ids.sort());
    const queue = JSON.parse(await readFile(path.join(workspace, "09-tasks", "dispatch_queue.json"), "utf8"))
      .filter((item) => children.some((task) => task.task_id === item.local_task_id));
    assert.deepEqual(queue.map((item) => item.local_task_id).sort(), children.map((task) => task.task_id).sort());
    const event = (await loadOnlyEvent(workspace)).event;
    assert.deepEqual(event.task_ids, [parent.task_id]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a Task discussed in another Human Event reuses the existing Task and Task Card", async () => {
  const workspace = await createWorkspace();
  try {
    await runScript(pipelinePath, workspace, { PROJECT_HERMES_EVENT_TEST_PROPOSAL_JSON: JSON.stringify(proposal) });
    const initial = await loadOnlyEvent(workspace);
    const topicId = "topic-existing";
    const taskId = "task-existing";
    const taskCardId = "taskcard-existing";
    const topicDir = path.join(workspace, "08-cards", "topics", topicId);
    const taskDir = path.join(workspace, "09-tasks", "tasks", taskId);
    await mkdir(topicDir, { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await writeJson(path.join(topicDir, "topic.json"), {
      topic_id: topicId,
      title: "Shared Topic",
      current_summary: "Existing topic.",
      human_event_ids: [],
      personal_card_ids: [],
      task_ids: [taskId],
      source_refs: [],
      status: "active",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z"
    });
    await writeJson(path.join(taskDir, "task.json"), {
      task_id: taskId,
      task_kind: "topic_task",
      task_card_id: taskCardId,
      title: "Implement shared action",
      content: "Old description.",
      topic_id: topicId,
      human_event_ids: ["he-older"],
      owner: "Zac Codex",
      owner_agent_id: "zac-agent",
      status: "completed",
      done_criteria: "Old criteria.",
      source_refs: [],
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z"
    });
    await writeFile(path.join(taskDir, "audit.jsonl"), "");
    await writeHumanCard(workspace, initial.event.human_event_id, "zac-card", "Zac", "Zac confirms the existing Task.");
    await writeHumanCard(workspace, initial.event.human_event_id, "vivi-card", "Vivi", "Vivi confirms the existing Task.");
    const finalization = {
      summary: "The existing Task was discussed again.",
      key_points: ["Reuse the existing Task."],
      topics: [{ title: "Shared Topic", summary: "Updated topic.", status: "approved", supporting_card_ids: ["zac-card", "vivi-card"], opposing_card_ids: [] }],
      tasks: [{
        title: "Implement shared action",
        content: "Updated description from the new Human Event.",
        topic_title: "Shared Topic",
        owner: "Zac Codex",
        done_criteria: "Updated artifact remains verified.",
        risk_level: "L1",
        status: "approved",
        supporting_card_ids: ["zac-card", "vivi-card"],
        opposing_card_ids: []
      }]
    };
    await runScript(pipelinePath, workspace, { PROJECT_HERMES_EVENT_TEST_FINALIZATION_JSON: JSON.stringify(finalization) }, ["--finalize-only"]);
    const tasks = (await loadTasks(workspace)).filter((task) => task.task_kind === "topic_task");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].task_id, taskId);
    assert.equal(tasks[0].status, "completed");
    assert.ok(tasks[0].human_event_ids.includes(initial.event.human_event_id));
    const audit = await readFile(path.join(taskDir, "audit.jsonl"), "utf8");
    assert.match(audit, /discussed_in_human_event/);
    assert.ok(await readFile(path.join(workspace, "08-cards", "cards", `card-${taskCardId}.md`), "utf8"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("zero human cards at deadline creates an incomplete summary and one Zac review without Topic or Task materialization", async () => {
  const workspace = await createWorkspace();
  try {
    await runScript(pipelinePath, workspace, { PROJECT_HERMES_EVENT_TEST_PROPOSAL_JSON: JSON.stringify(proposal) });
    const initial = await loadOnlyEvent(workspace);
    const expiredAt = "2026-01-01T00:00:00.000Z";
    initial.event.card_collection_deadline_at = expiredAt;
    initial.review.card_collection_deadline_at = expiredAt;
    await writeJson(initial.eventPath, initial.event);
    await writeJson(initial.reviewPath, initial.review);
    const finalization = {
      summary: "Incomplete summary from transcript and Hermes card.",
      key_points: ["No human card arrived."],
      topics: [{ title: "Shared Topic", summary: "Candidate", status: "approved", supporting_card_ids: [], opposing_card_ids: [] }],
      tasks: [{ title: "Implement shared action", content: "Candidate", status: "approved", supporting_card_ids: [], opposing_card_ids: [] }]
    };
    await runScript(pipelinePath, workspace, { PROJECT_HERMES_EVENT_TEST_FINALIZATION_JSON: JSON.stringify(finalization) }, ["--finalize-only"]);

    const { event, review } = await loadOnlyEvent(workspace);
    const tasks = await loadTasks(workspace);
    assert.equal(event.summary_status, "incomplete");
    assert.equal(event.finalization_reason, "deadline");
    assert.deepEqual(event.missing_card_authors, ["zac", "vivi"]);
    assert.equal(event.topic_ids.length, 0);
    assert.equal(event.task_ids.length, 0);
    assert.equal(review.status, "need_review");
    assert.ok(review.resolution.topics.every((item) => item.status === "need_review"));
    assert.ok(review.resolution.tasks.every((item) => item.status === "need_review"));
    assert.equal(tasks.filter((task) => task.task_kind === "human_event_review").length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an expired no-objection Review closes and materializes all non-L3 candidates", async () => {
  const workspace = await createWorkspace();
  try {
    await runScript(pipelinePath, workspace, { PROJECT_HERMES_EVENT_TEST_PROPOSAL_JSON: JSON.stringify(proposal) });
    const initial = await loadOnlyEvent(workspace);
    initial.event.card_collection_deadline_at = "2026-01-01T00:00:00.000Z";
    initial.review.card_collection_deadline_at = initial.event.card_collection_deadline_at;
    await writeJson(initial.eventPath, initial.event);
    await writeJson(initial.reviewPath, initial.review);
    const finalization = {
      summary: "Incomplete summary awaiting Review.",
      key_points: ["No human card arrived before the deadline."],
      topics: [{ title: "Shared Topic", summary: "Candidate topic.", status: "approved", supporting_card_ids: [], opposing_card_ids: [] }],
      tasks: [{ ...proposal.tasks[0], status: "approved", supporting_card_ids: [], opposing_card_ids: [] }]
    };
    await runScript(pipelinePath, workspace, { PROJECT_HERMES_EVENT_TEST_FINALIZATION_JSON: JSON.stringify(finalization) }, ["--finalize-only"]);
    let current = await loadOnlyEvent(workspace);
    const reviewTask = (await loadTasks(workspace)).find((task) => task.task_kind === "human_event_review");
    assert.ok(reviewTask);
    assert.equal(reviewTask.timeout_policy, "default_no_objection");
    await runScript(pipelinePath, workspace, {}, ["--finalize-only", "--review-timeout-task-id", reviewTask.task_id]);
    current = await loadOnlyEvent(workspace);
    const updatedReviewTask = (await loadTasks(workspace)).find((task) => task.task_id === reviewTask.task_id);
    assert.equal(updatedReviewTask.status, "expired");
    assert.equal(updatedReviewTask.review_resolution, "timeout_assumed_no_objection");
    assert.equal(current.review.status, "finalized");
    assert.equal(current.event.status, "materialized");
    assert.equal(current.event.topic_ids.length, 1);
    assert.equal(current.event.task_ids.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("one human card at deadline materializes only explicitly supported decisions", async () => {
  const workspace = await createWorkspace();
  try {
    await runScript(pipelinePath, workspace, { PROJECT_HERMES_EVENT_TEST_PROPOSAL_JSON: JSON.stringify(proposal) });
    const initial = await loadOnlyEvent(workspace);
    initial.event.card_collection_deadline_at = "2026-01-01T00:00:00.000Z";
    initial.review.card_collection_deadline_at = initial.event.card_collection_deadline_at;
    await writeJson(initial.eventPath, initial.event);
    await writeJson(initial.reviewPath, initial.review);
    await writeHumanCard(workspace, initial.event.human_event_id, "zac-card", "Zac", "Zac confirms the shared Topic and Task.");
    const finalization = {
      summary: "Incomplete summary with Zac's card.",
      key_points: ["Zac confirmed one action."],
      topics: [
        { title: "Shared Topic", summary: "Confirmed", status: "approved", supporting_card_ids: ["zac-card"], opposing_card_ids: [] },
        { title: "Unconfirmed Topic", summary: "No human support", status: "approved", supporting_card_ids: [], opposing_card_ids: [] }
      ],
      tasks: [
        { title: "Implement shared action", content: "Produce the agreed artifact.", topic_title: "Shared Topic", owner: "Zac Codex", done_criteria: "Artifact exists.", status: "approved", supporting_card_ids: ["zac-card"], opposing_card_ids: [] },
        { title: "Unconfirmed action", content: "Do something inferred.", topic_title: "Unconfirmed Topic", owner: "", done_criteria: "Unknown", status: "approved", supporting_card_ids: [], opposing_card_ids: [] }
      ]
    };
    await runScript(pipelinePath, workspace, { PROJECT_HERMES_EVENT_TEST_FINALIZATION_JSON: JSON.stringify(finalization) }, ["--finalize-only"]);

    let { event, review, reviewPath } = await loadOnlyEvent(workspace);
    assert.equal(event.summary_status, "incomplete");
    assert.deepEqual(event.missing_card_authors, ["vivi"]);
    assert.equal(event.topic_ids.length, 1);
    assert.equal(event.task_ids.length, 1);
    assert.equal(review.status, "need_review");
    assert.equal(review.resolution.topics.find((item) => item.title === "Unconfirmed Topic").status, "need_review");
    assert.equal(review.resolution.tasks.find((item) => item.title === "Unconfirmed action").status, "need_review");

    review.status = "resolved";
    review.manager_decisions = {
      topics: [{ title: "Unconfirmed Topic", status: "approved" }],
      tasks: [{ title: "Unconfirmed action", status: "approved" }]
    };
    await writeJson(reviewPath, review);
    await runScript(pipelinePath, workspace, {}, ["--finalize-only"]);
    ({ event, review } = await loadOnlyEvent(workspace));
    assert.equal(event.topic_ids.length, 2);
    assert.equal(event.task_ids.length, 2);
    assert.equal(review.status, "finalized");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("L3 Tasks remain prohibited during finalization and Zac Review", async () => {
  const workspace = await createWorkspace();
  try {
    const l3Proposal = {
      ...proposal,
      tasks: [{ ...proposal.tasks[0], risk_level: "L3" }]
    };
    await runScript(pipelinePath, workspace, { PROJECT_HERMES_EVENT_TEST_PROPOSAL_JSON: JSON.stringify(l3Proposal) });
    const initial = await loadOnlyEvent(workspace);
    await writeHumanCard(workspace, initial.event.human_event_id, "zac-card", "Zac", "Zac supports the action.");
    await writeHumanCard(workspace, initial.event.human_event_id, "vivi-card", "Vivi", "Vivi supports the action.");
    const finalization = {
      summary: "Both cards support an action whose risk remains L3.",
      key_points: ["L3 is prohibited."],
      topics: [],
      tasks: [{
        ...l3Proposal.tasks[0],
        status: "approved",
        supporting_card_ids: ["zac-card", "vivi-card"],
        opposing_card_ids: []
      }]
    };
    await runScript(pipelinePath, workspace, { PROJECT_HERMES_EVENT_TEST_FINALIZATION_JSON: JSON.stringify(finalization) }, ["--finalize-only"]);
    let current = await loadOnlyEvent(workspace);
    assert.equal(current.event.task_ids.length, 0);
    // The omitted Topic still needs review; the L3 Task itself is already terminally rejected.
    assert.equal(current.review.status, "need_review");
    assert.equal(current.review.resolution.tasks[0].status, "rejected_l3");
    assert.deepEqual(current.review.resolution.tasks[0].l3_rule_ids, ["L3-DECLARED-001"]);

    // Even a later explicit Zac approval cannot override the L3 boundary.
    current.review.status = "resolved";
    current.review.manager_decisions = { topics: [], tasks: [{ title: "Implement shared action", status: "approved" }] };
    await writeJson(current.reviewPath, current.review);
    await runScript(pipelinePath, workspace, {}, ["--finalize-only"]);
    current = await loadOnlyEvent(workspace);
    assert.equal(current.event.task_ids.length, 0);
    assert.equal(current.review.status, "finalized");
    assert.equal(current.review.consensus.tasks[0].status, "rejected_l3");
    assert.ok(current.review.l3_rejections.length > 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a valid Human Event Personal Card bypasses legacy Event review and validates the submission task", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "human-event-card-"));
  try {
    const humanEventId = "he-direct-test";
    const eventDir = path.join(workspace, "08-cards", "human-events", "records", humanEventId);
    await mkdir(eventDir, { recursive: true });
    await writeJson(path.join(eventDir, "event.json"), {
      human_event_id: humanEventId,
      type: "chat",
      title: "Direct Card Event",
      personal_card_ids: [],
      source_refs: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    await writeJson(path.join(eventDir, "review.json"), { human_event_id: humanEventId, status: "pending_cards", human_card_ids: [] });
    const inbox = path.join(workspace, "08-cards", "inbox", "zac-draft");
    await mkdir(inbox, { recursive: true });
    await writeFile(
      path.join(inbox, "zac-card.md"),
      cardMarkdown(humanEventId, "Zac", "Direct submission", "", "topic-direct", ["source-a.md", "source-b.md"])
    );
    const taskId = "task-cardtest";
    const taskDir = path.join(workspace, "09-tasks", "tasks", taskId);
    await mkdir(taskDir, { recursive: true });
    await writeJson(path.join(taskDir, "task.json"), { task_id: taskId, task_kind: "card_submission", owner: "Zac", human_event_ids: [humanEventId] });

    await runScript(cardIngestPath, workspace, { PROJECT_HERMES_COMMAND: "/bin/false" });
    await runScript(validatorPath, workspace, {}, ["--task-id", taskId]);
    const index = JSON.parse(await readFile(path.join(workspace, "08-cards", "card_index.json"), "utf8"));
    const card = index.cards.find((item) => item.human_event_id === humanEventId && item.author === "Zac");
    assert.ok(card);
    assert.equal(card.card_id, card.content_id);
    assert.equal(card.topic_id, "topic-direct");
    assert.ok(card.source_refs.includes("source-a.md"));
    assert.ok(card.source_refs.includes("source-b.md"));
    assert.ok(card.card_path.startsWith("08-cards/cards/card-"));
    assert.equal((await loadFiles(path.join(workspace, "08-cards", "review"))).length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a non-standard Human Event Artifact receives a bounded deterministic summary", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "human-event-card-summary-"));
  try {
    const humanEventId = "he-summary-test";
    const eventDir = path.join(workspace, "08-cards", "human-events", "records", humanEventId);
    const inbox = path.join(workspace, "08-cards", "inbox", "zac-draft");
    await mkdir(eventDir, { recursive: true });
    await mkdir(inbox, { recursive: true });
    await writeJson(path.join(eventDir, "event.json"), {
      human_event_id: humanEventId,
      type: "meeting",
      title: "Summary Event",
      personal_card_ids: [],
      source_refs: []
    });
    await writeJson(path.join(eventDir, "review.json"), { human_event_id: humanEventId, status: "pending_cards", human_card_ids: [] });
    await writeFile(path.join(inbox, "artifact.md"), [
      "---",
      `human_event_id: ${humanEventId}`,
      "card_type: personal",
      "author: Zac",
      "occurred_at: 2026-08-03T02:00:00.000Z",
      'title: "Zac Artifact"',
      "---",
      "",
      "# Zac Artifact",
      "",
      "## 我的判断",
      "- 统一的 Artifact 入库链路已经可以复用。",
      "- Hermes 需要先总结，再决定是否创建 Topic。",
      "- 原始内容继续保留用于审计。",
      "",
      "## 展示反馈",
      "- 首页只展示摘要，详细内容在展开后查看。",
      ""
    ].join("\n"));

    await runScript(cardIngestPath, workspace, { PROJECT_HERMES_COMMAND: "/bin/false" });
    const index = JSON.parse(await readFile(path.join(workspace, "08-cards", "card_index.json"), "utf8"));
    const card = index.cards.find((item) => item.human_event_id === humanEventId);
    assert.ok(card);
    assert.ok(card.key_points.length > 0);
    assert.ok(card.key_points.length <= 3);
    assert.equal(card.placement_type, "human_event");
    const cardText = await readFile(path.join(workspace, card.card_path), "utf8");
    assert.match(cardText, /## 卡片要点/);
    assert.match(cardText, /## 原始 Artifact/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a Personal Card with only topic_id is archived under the Topic relation", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "topic-card-"));
  try {
    const topicId = "topic-direct";
    const topicDir = path.join(workspace, "08-cards", "topics", topicId);
    const inbox = path.join(workspace, "08-cards", "inbox", "vivi-draft");
    await mkdir(topicDir, { recursive: true });
    await mkdir(inbox, { recursive: true });
    await writeJson(path.join(topicDir, "topic.json"), {
      topic_id: topicId,
      title: "Direct Topic",
      personal_card_ids: [],
      task_ids: [],
      source_refs: []
    });
    await writeFile(path.join(inbox, "topic-card.md"), [
      "---",
      `topic_id: ${topicId}`,
      "card_type: personal",
      "author: Vivi",
      "occurred_at: 2026-08-03T02:00:00.000Z",
      'title: "Vivi Topic View"',
      "---",
      "",
      "# Vivi Topic View",
      "",
      "## 结论",
      "- Topic 需要持续记录验证结果。",
      ""
    ].join("\n"));

    await runScript(cardIngestPath, workspace, { PROJECT_HERMES_COMMAND: "/bin/false" });
    const index = JSON.parse(await readFile(path.join(workspace, "08-cards", "card_index.json"), "utf8"));
    const card = index.cards.find((item) => item.topic_id === topicId);
    assert.ok(card);
    assert.equal(card.placement_type, "topic");
    const topic = JSON.parse(await readFile(path.join(topicDir, "topic.json"), "utf8"));
    assert.ok(topic.personal_card_ids.includes(card.card_id));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("a Human Event Card with an author conflicting with its inbox is rejected into validation Review", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "human-event-card-invalid-"));
  try {
    const humanEventId = "he-invalid-card";
    const eventDir = path.join(workspace, "08-cards", "human-events", "records", humanEventId);
    const inbox = path.join(workspace, "08-cards", "inbox", "zac-draft");
    await mkdir(eventDir, { recursive: true });
    await mkdir(inbox, { recursive: true });
    await writeJson(path.join(eventDir, "event.json"), { human_event_id: humanEventId, type: "chat", title: "Invalid Card Event", personal_card_ids: [], source_refs: [] });
    await writeJson(path.join(eventDir, "review.json"), { human_event_id: humanEventId, status: "pending_cards" });
    await writeFile(path.join(inbox, "wrong-author.md"), cardMarkdown(humanEventId, "Vivi", "Wrong inbox author"));

    await runScript(cardIngestPath, workspace, { PROJECT_HERMES_COMMAND: "/bin/false" });
    const index = JSON.parse(await readFile(path.join(workspace, "08-cards", "card_index.json"), "utf8"));
    const reviewFiles = await loadFiles(path.join(workspace, "08-cards", "review"), "review.json");
    assert.equal(index.cards.length, 0);
    assert.equal(reviewFiles.length, 1);
    const review = JSON.parse(await readFile(reviewFiles[0], "utf8"));
    assert.equal(review.review_kind, "human_event_card_validation");
    assert.equal(review.submitted_by, "zac");
    assert.equal(review.owner, "Zac");
    assert.equal(review.owner_agent_id, "zac-agent");
    const reviewTasks = await loadTasks(workspace);
    const managerTask = reviewTasks.find((task) => task.task_kind === "card_validation_review");
    assert.ok(managerTask);
    assert.equal(managerTask.owner, "Zac");
    assert.equal(managerTask.task_role, "manager_review");
    assert.match(review.question, /Correct the card author/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("an approved intake recovers an existing archived Card with the same ingest_id", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "card-ingest-recovery-"));
  try {
    const ingestId = "ing-recovery";
    const cardId = "card-recovered";
    const eventId = "evt-recovered";
    const intakeDir = path.join(workspace, "08-cards", "processing", ingestId);
    const eventDir = path.join(workspace, "08-cards", "events", eventId, "cards");
    const sourceRef = `08-cards/events/${eventId}/sources/${ingestId}-source.md`;
    await mkdir(intakeDir, { recursive: true });
    await mkdir(eventDir, { recursive: true });
    await writeJson(path.join(intakeDir, "intake.json"), {
      schema_version: 1,
      ingest_id: ingestId,
      owner: "vivi",
      original_filename: "source.md",
      source_path: `08-cards/processing/${ingestId}/source.md`,
      submitted_at: "2026-08-03T01:00:00.000Z",
      status: "approved",
      event_id: "evt-stale",
      card_id: "card-stale",
      last_error: "processing source is missing"
    });
    await writeFile(path.join(eventDir, "card.md"), [
      "---",
      `card_id: ${cardId}`,
      `event_id: ${eventId}`,
      "card_type: personal",
      "author: vivi",
      "occurred_at: 2026-08-03T01:00:00.000Z",
      'title: "Recovered Card"',
      `source_ref: ${sourceRef}`,
      `ingest_id: ${ingestId}`,
      "---",
      "",
      "# Recovered Card",
      ""
    ].join("\n"));

    await runScript(cardIngestPath, workspace, { PROJECT_HERMES_COMMAND: "/bin/false" });

    const intake = JSON.parse(await readFile(path.join(intakeDir, "intake.json"), "utf8"));
    assert.equal(intake.status, "archived");
    assert.equal(intake.card_id, cardId);
    assert.equal(intake.event_id, eventId);
    assert.equal(intake.source_destination, sourceRef);
    assert.equal("last_error" in intake, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function createWorkspace() {
  const workspace = await mkdtemp(path.join(tmpdir(), "human-event-pipeline-"));
  const inbox = path.join(workspace, "08-cards", "human-events", "inbox", "chat");
  await mkdir(inbox, { recursive: true });
  await writeFile(path.join(inbox, "chat.txt"), "Zac and Vivi discussed a shared Topic and agreed on one implementation Task.\n");
  return workspace;
}

async function writeHumanCard(workspace, humanEventId, cardId, author, conclusion) {
  const cardDir = path.join(workspace, "08-cards", "cards");
  await mkdir(cardDir, { recursive: true });
  await writeFile(path.join(cardDir, `card-${cardId}.md`), cardMarkdown(humanEventId, author, conclusion, cardId));
}

function cardMarkdown(humanEventId, author, conclusion, cardId = "", topicId = "", sourceRefs = []) {
  return [
    "---",
    ...(cardId ? [`card_id: ${cardId}`, `content_id: ${cardId}`] : []),
    `human_event_id: ${humanEventId}`,
    `event_id: ${humanEventId}`,
    ...(topicId ? [`topic_id: ${topicId}`] : []),
    "card_type: personal",
    `author: ${author}`,
    "occurred_at: 2026-08-03T02:00:00.000Z",
    `title: ${JSON.stringify(`${author} view`)}`,
    "participants:",
    `  - ${author}`,
    ...(sourceRefs.length ? ["source_refs:", ...sourceRefs.map((sourceRef) => `  - ${sourceRef}`)] : []),
    "---",
    "",
    `# ${author} view`,
    "",
    "## 讨论结论",
    `- ${conclusion}`,
    "",
    "## 下一步",
    "- Implement shared action",
    ""
  ].join("\n");
}

async function loadOnlyEvent(workspace) {
  const recordsRoot = path.join(workspace, "08-cards", "human-events", "records");
  const directories = await readdir(recordsRoot);
  assert.equal(directories.length, 1);
  const eventPath = path.join(recordsRoot, directories[0], "event.json");
  const reviewPath = path.join(recordsRoot, directories[0], "review.json");
  return {
    eventPath,
    reviewPath,
    event: JSON.parse(await readFile(eventPath, "utf8")),
    review: JSON.parse(await readFile(reviewPath, "utf8"))
  };
}

async function loadTasks(workspace) {
  const files = await loadFiles(path.join(workspace, "09-tasks", "tasks"), "task.json");
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
}

async function loadFiles(root, basename = "") {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await loadFiles(file, basename));
    else if (!basename || entry.name === basename) files.push(file);
  }
  return files;
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function loadOnlyIntake(workspace) {
  const files = await loadFiles(path.join(workspace, "08-cards", "human-events", "processing"), "intake.json");
  assert.equal(files.length, 1);
  return JSON.parse(await readFile(files[0], "utf8"));
}

async function writeFakeHermes(workspace) {
  const file = path.join(workspace, "fake-hermes.sh");
  await writeFile(file, `#!/usr/bin/env bash
set -eu
prompt="\${!#}"
if [[ "$FAKE_HERMES_MODE" == "stdout" ]]; then
  printf '%s\\n' "$FAKE_HERMES_PROPOSAL"
elif [[ "$FAKE_HERMES_MODE" == "proposal-file" ]]; then
  proposal_path="$(printf '%s\\n' "$prompt" | sed -n 's/^If the runtime cannot return JSON on stdout, the only permitted file output is \\(.*proposal.json\\)\\.$/\\1/p')"
  [[ -n "$proposal_path" ]]
  printf '%s\\n' "$FAKE_HERMES_PROPOSAL" > "$proposal_path"
  printf '%s\\n' 'Proposal saved.'
elif [[ "$FAKE_HERMES_MODE" == "repair" && "$prompt" == Repair\\ the\\ following* ]]; then
  printf '%s\\n' "$FAKE_HERMES_PROPOSAL"
else
  printf '%s\\n' 'No JSON was returned.'
fi
`);
  await chmod(file, 0o755);
  return file;
}

function runScript(script, workspace, extraEnv = {}, args = []) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: workspace,
      env: { ...process.env, COLLAB_WORKSPACE: workspace, PROJECT_HERMES_CONFIG: path.join(workspace, "missing-config.yaml"), PROJECT_HERMES_COMMAND: "/bin/false", ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", rejectRun);
    child.on("close", (code) => code === 0 ? resolveRun(stdout) : rejectRun(new Error(`${path.basename(script)} exited ${code}\n${stdout}\n${stderr}`)));
  });
}
