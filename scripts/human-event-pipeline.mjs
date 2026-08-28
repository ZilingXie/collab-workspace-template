#!/usr/bin/env node

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendJsonLine,
  cardContentHash,
  excerpt,
  getWorkspaceRoot,
  isTextFile,
  normalizeSlug,
  normalizeSummaryPoints,
  randomId,
  readJson,
  relativePath,
  fallbackSummaryPoints,
  unique,
  walkFiles,
  writeJsonAtomic
} from "./card-v1-lib.mjs";
import {
  analysisToProposal,
  readAnalysisPackage
} from "./analysis-package.mjs";
import {
  loadProjectHermesModelConfig,
  parseJsonObject,
  readJsonObjectFile,
  runHermesCommand
} from "./hermes-structured-output.mjs";
import {
  createProjectTask,
  enqueueProjectTask,
  normalizeInputArtifacts,
  renderTaskIndex as renderRegistryTaskIndex
} from "./task-registry.mjs";
import { loadProjectRoles, projectManager } from "./project-roles.mjs";
import { createFanoutCollection } from "./fanout-collection.mjs";
import {
  appendL3Audit,
  assertL3Allowed,
  evaluateL3Request,
  loadL3Policy
} from "./l3-policy.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = getWorkspaceRoot(scriptDirectory);
const cardsRoot = path.join(workspaceRoot, "08-cards");
const humanEventsRoot = path.join(cardsRoot, "human-events");
const inputRoot = path.join(humanEventsRoot, "inbox");
const recordsRoot = path.join(humanEventsRoot, "records");
const topicsRoot = path.join(cardsRoot, "topics");
const tasksRoot = path.join(workspaceRoot, "09-tasks");
const taskRecordsRoot = path.join(tasksRoot, "tasks");
const l3Policy = await loadL3Policy(workspaceRoot);
const projectRoles = await loadProjectRoles(workspaceRoot);
const manager = projectManager(projectRoles);
const queuePath = path.join(tasksRoot, "dispatch_queue.json");
const pipelineLog = path.join(humanEventsRoot, "pipeline.jsonl");
const hermesCommand = process.env.PROJECT_HERMES_COMMAND || "hermes";
const hermesMaxTurns = Number(process.env.PROJECT_HERMES_EVENT_MAX_TURNS || 6);
const hermesTimeoutMs = Number(process.env.PROJECT_HERMES_EVENT_TIMEOUT_MS || 900000);
const maxSourceChars = Number(process.env.PROJECT_HERMES_EVENT_MAX_SOURCE_CHARS || 90000);
const modelConfig = loadProjectHermesModelConfig();
const modelProvider = modelConfig.provider || process.env.PROJECT_HERMES_MODEL_PROVIDER || "deepseek";
const decisionModel = modelConfig.decision_model || process.env.PROJECT_HERMES_DECISION_MODEL || "deepseek-v4-pro";
const fallbackModel = modelConfig.fallback_model || process.env.PROJECT_HERMES_FALLBACK_MODEL || decisionModel;
const flashEnabledValue = modelConfig.flash_enabled ?? process.env.PROJECT_HERMES_FLASH_ENABLED ?? "1";
const flashEnabled = !["0", "false", "no", "off"].includes(String(flashEnabledValue).toLowerCase());
const extractionModel = flashEnabled
  ? (modelConfig.extraction_model || process.env.PROJECT_HERMES_EXTRACTION_MODEL || "deepseek-v4-flash")
  : decisionModel;
const renderOnly = process.argv.includes("--render-only");
const dryRun = process.argv.includes("--dry-run");
const finalizeOnly = process.argv.includes("--finalize-only");
const chatOnly = process.argv.includes("--chat-only");
const reviewTimeoutTaskId = argument("--review-timeout-task-id");

await ensureDirectories();
let claimed = 0;
let created = 0;
let finalized = 0;
let pending = 0;
let failed = 0;

if (!renderOnly && !dryRun && !finalizeOnly) {
  await claimInputs();
  for (const intakePath of await findIntakes()) {
    try {
      const intake = await readJson(intakePath);
      if (["archived", "review", "finalized"].includes(intake.status)) continue;
      await processIntake(intakePath, intake);
      created += 1;
    } catch (error) {
      failed += 1;
      const intake = await readJson(intakePath, {});
      intake.status = "retry";
      intake.last_error = String(error.message || error);
      intake.updated_at = new Date().toISOString();
      await writeJsonAtomic(intakePath, intake);
      await audit("human_event.failed", { ingest_id: intake.ingest_id, error: intake.last_error });
    }
  }
}

await rebuildIndexes();
if (!renderOnly && !dryRun) {
  if (reviewTimeoutTaskId) await applyReviewTimeout(reviewTimeoutTaskId);
  else await applyExpiredReviewTasks();
  for (const reviewPath of await findEventReviews()) {
    try {
      const review = await readJson(reviewPath);
      if (["pending_cards", "materializing"].includes(review.status)) {
        const result = await tryFinalize(reviewPath, review);
        if (result === "finalized") finalized += 1;
        else pending += 1;
        continue;
      }
      if (["manager_resolved", "resolved", "zac_resolved", "zac_materializing"].includes(review.status)) {
        const result = await applyZacReview(reviewPath, review);
        if (result === "finalized") finalized += 1;
        else pending += 1;
      }
      continue;
    } catch (error) {
      failed += 1;
      await audit("human_event.finalize_failed", { review_path: relativePath(workspaceRoot, reviewPath), error: String(error.message || error) });
    }
  }
  await syncReviewTaskMirrors();
  if (finalized > 0) await rebuildIndexes();
}

await renderTaskIndex();
console.log(JSON.stringify({ ok: failed === 0, claimed, created, finalized, pending, failed, workspace: workspaceRoot }, null, 2));
if (failed) process.exitCode = 1;

async function ensureDirectories() {
  for (const dir of [
    path.join(inputRoot, "meetings"),
    path.join(inputRoot, "chat"),
    recordsRoot,
    path.join(cardsRoot, "cards"),
    path.join(cardsRoot, "contents"),
    topicsRoot,
    taskRecordsRoot
  ]) await fs.mkdir(dir, { recursive: true, mode: 0o2775 });
}

async function claimInputs() {
  for (const kind of chatOnly ? ["chat"] : ["meetings", "chat"]) {
    const sourceDir = path.join(inputRoot, kind);
    const files = await walkFiles(sourceDir, (filePath) => isTextFile(filePath) || path.extname(filePath).toLowerCase() === ".json");
    for (const sourcePath of files) {
      const pointer = path.extname(sourcePath).toLowerCase() === ".json"
        ? await readJson(sourcePath, null)
        : null;
      if (pointer && (!isAnalysisV2(pointer.schema_version) || !pointer.analysis_path || !pointer.source_path)) continue;
      const isV2 = isAnalysisV2(pointer?.schema_version);
      const ingestId = pointer?.ingest_id || randomId("ing-", 8);
      const intakeDir = path.join(humanEventsRoot, "processing", ingestId);
      await fs.mkdir(intakeDir, { recursive: true, mode: 0o2775 });
      const destination = path.join(intakeDir, path.basename(sourcePath));
      const stats = await fs.stat(sourcePath);
      await fs.rename(sourcePath, destination);
      await writeJsonAtomic(path.join(intakeDir, "intake.json"), {
        schema_version: isV2 ? Number(pointer.schema_version) : 1,
        ingest_id: ingestId,
        human_event_type: kind === "chat" ? "chat" : "meeting",
        original_filename: pointer?.original_filename || path.basename(sourcePath),
        source_path: relativePath(workspaceRoot, destination),
        raw_source_path: pointer?.source_path || null,
        analysis_path: pointer?.analysis_path || null,
        manifest_path: pointer?.manifest_path || null,
        submitted_at: stats.mtime.toISOString(),
        status: "claimed",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      claimed += 1;
      await audit("human_event.claimed", { ingest_id: ingestId, type: kind, source_path: relativePath(workspaceRoot, destination) });
    }
  }
}

async function findIntakes() {
  return walkFiles(path.join(humanEventsRoot, "processing"), (filePath) => path.basename(filePath) === "intake.json");
}

async function processIntake(intakePath, intake) {
  const isV2 = isAnalysisV2(intake.schema_version) && intake.analysis_path && intake.raw_source_path;
  const sourcePath = path.join(workspaceRoot, isV2 ? intake.raw_source_path : intake.source_path);
  const sourceText = isV2 ? "" : await fs.readFile(sourcePath, "utf8");
  const proposal = isV2
    ? analysisToProposal(await readAnalysisPackage(workspaceRoot, intake.analysis_path), { sourceRef: intake.raw_source_path })
    : normalizeProposal(await askHermes(intakePath, intake, sourceText));
  const humanEventId = randomId("he-", 8);
  const eventDir = path.join(recordsRoot, humanEventId);
  const sourceDir = path.join(eventDir, "sources");
  await fs.mkdir(sourceDir, { recursive: true, mode: 0o2775 });
  const archivedSource = isV2 ? sourcePath : path.join(sourceDir, intake.original_filename);
  if (!isV2) {
    await fs.rename(sourcePath, archivedSource);
    await fs.chmod(archivedSource, 0o664).catch(() => {});
  }

  const now = new Date().toISOString();
  // The 72-hour card window starts when immediate Relay dispatch succeeds.
  // The dispatcher stamps the shared deadline; 10:00 only reports reminders.
  const cardCollectionDeadlineAt = null;
  const event = {
    schema_version: 1,
    human_event_id: humanEventId,
    type: intake.human_event_type,
    title: proposal.title,
    occurred_at: proposal.occurred_at,
    participants: proposal.participants,
    agent_participants: proposal.agent_participants || [],
    system_actors: proposal.system_actors || [],
    source_actor_names: proposal.source_actor_names || proposal.participants,
    started_at: proposal.started_at || proposal.occurred_at,
    ended_at: proposal.ended_at || null,
    source_refs: [relativePath(workspaceRoot, archivedSource)],
    analysis_ref: isV2 ? intake.analysis_path : null,
    ingest_id: intake.ingest_id,
    summary_status: "provisional",
    summary: proposal.summary,
    key_points: proposal.key_points,
    candidate_topics: proposal.topics,
    candidate_tasks: proposal.tasks,
    method_candidates: proposal.method_candidates || [],
    topic_ids: [],
    task_ids: [],
    personal_card_ids: [],
    card_collection_deadline_at: cardCollectionDeadlineAt,
    status: "pending_human_review",
    created_at: now,
    updated_at: now
  };
  await writeJsonAtomic(path.join(eventDir, "event.json"), event);

  const hermesCard = await createHermesPersonalCard(event, archivedSource, proposal, now);
  event.personal_card_ids.push(hermesCard.card_id);
  await writeJsonAtomic(path.join(eventDir, "event.json"), event);

  const review = {
    schema_version: 1,
    review_id: randomId("review-", 8),
    human_event_id: humanEventId,
    event_path: relativePath(workspaceRoot, path.join(eventDir, "event.json")),
    type: intake.human_event_type,
    status: "pending_cards",
    card_submission_task_ids: [],
    human_card_ids: [],
    card_ids_by_author: {},
    expected_authors: ["hermes", "zac", "vivi"],
    card_collection_deadline_at: cardCollectionDeadlineAt,
    consensus: null,
    created_at: now,
    updated_at: now
  };

  for (const person of [{ key: "zac", agent: "zac-agent", name: "Zac" }, { key: "vivi", agent: "vivi-agent", name: "Vivi" }]) {
    const task = await createLocalTask({
      task_kind: "card_submission",
      title: `提交交流记录卡片：${proposal.title}`,
      content: `请阅读交流记录 ${humanEventId} 的原始材料与 Hermes Personal Card，提交你的 Personal Card。卡片可以确认、修改、反对或补充内部候选项目议题/任务。请将文件放入 08-cards/inbox/${person.key}-draft/，并在 frontmatter 中填写 human_event_id: ${humanEventId}、card_type: personal、author: ${person.name}。`,
      owner: person.name,
      target_agent_id: person.agent,
      human_event_ids: [humanEventId],
      done_criteria: `Personal Card 已写入 08-cards/inbox/${person.key}-draft/，frontmatter 包含 human_event_id: ${humanEventId}，且 author 与 ${person.name} 一致。只提交卡片，不要直接修改项目议题或 Task。`,
      source_refs: event.source_refs,
      due_at: cardCollectionDeadlineAt,
      priority: "medium",
      risk_level: "L0"
    });
    review.card_submission_task_ids.push(task.task_id);
    await enqueueRelayTask(task);
  }
  await writeJsonAtomic(path.join(eventDir, "review.json"), review);
  intake.status = "review";
  delete intake.last_error;
  delete intake.proposal_ready;
  intake.human_event_id = humanEventId;
  intake.event_path = relativePath(workspaceRoot, path.join(eventDir, "event.json"));
  intake.review_path = relativePath(workspaceRoot, path.join(eventDir, "review.json"));
  if (isV2 && intake.manifest_path) {
    const manifestPath = path.join(workspaceRoot, intake.manifest_path);
    const manifest = await readJson(manifestPath, null);
    if (manifest) {
      manifest.human_event_id = humanEventId;
      manifest.status = "event_created";
      manifest.updated_at = now;
      await writeJsonAtomic(manifestPath, manifest);
    }
  }
  intake.updated_at = now;
  await writeJsonAtomic(intakePath, intake);
  await audit("human_event.created", { human_event_id: humanEventId, type: event.type, title: event.title, review_path: intake.review_path });
}

async function createHermesPersonalCard(event, sourcePath, proposal, now) {
  const cardId = randomId("", 8);
  const cardPath = path.join(cardsRoot, "cards", `card-${cardId}.md`);
  const keyPoints = normalizeSummaryPoints(proposal.key_points).length
    ? normalizeSummaryPoints(proposal.key_points)
    : fallbackSummaryPoints(proposal.summary, event.title, 3);
  const contentPath = path.join(cardsRoot, "contents", `content-${cardId}.md`);
  const cardTitle = `Hermes：${event.title}`;
  const contentHash = cardContentHash({
    human_event_id: event.human_event_id,
    author: "Hermes",
    card_type: "personal",
    title: cardTitle,
    summary: proposal.summary || keyPoints[0] || "",
    key_points: keyPoints
  }, proposal.summary || event.title);
  const lines = [
    "---",
    `card_id: ${cardId}`,
    `content_id: ${cardId}`,
    `event_id: ${event.human_event_id}`,
    `human_event_id: ${event.human_event_id}`,
    "placement_type: human_event",
    `placement_id: ${event.human_event_id}`,
    "card_type: personal",
    "author: Hermes",
    `occurred_at: ${event.occurred_at}`,
    `submitted_at: ${now}`,
    `summary: ${JSON.stringify(proposal.summary || keyPoints[0] || "")}`,
    "summary_method: hermes_event_proposal",
    "lifecycle_status: accepted",
    `content_hash: ${contentHash}`,
    `revision_group_id: human_event:${event.human_event_id}:author:hermes`,
    "revision_number: 1",
    `title: ${JSON.stringify(cardTitle)}`,
    "participants:",
    ...event.participants.map((person) => `  - ${person}`),
    `source_ref: ${relativePath(workspaceRoot, sourcePath)}`,
    "---",
    "",
    `# Hermes：${event.title}`,
    "",
    "## 卡片要点",
    ...keyPoints.map((item) => `- ${item}`),
    "",
    "## Hermes 交流总结",
    `- ${proposal.summary || "NA"}`,
    ""
  ];
  await fs.writeFile(cardPath, lines.join("\n"), { mode: 0o664 });
  await fs.writeFile(contentPath, [
    `# ${event.title}`,
    "",
    proposal.summary || keyPoints[0] || "",
    "",
    "## 原始材料",
    `- ${relativePath(workspaceRoot, sourcePath)}`
  ].join("\n").trim() + "\n", { mode: 0o664 });
  return { card_id: cardId, card_path: relativePath(workspaceRoot, cardPath), content_path: relativePath(workspaceRoot, contentPath) };
}

async function tryFinalize(reviewPath, review) {
  const eventPath = path.join(workspaceRoot, review.event_path);
  const event = await readJson(eventPath);
  const index = await readJson(path.join(cardsRoot, "card_index.json"), { cards: [] });
  const cards = (index.cards || []).filter((card) => (
    card.human_event_id === review.human_event_id
    || card.event_id === review.human_event_id
  ) && String(card.lifecycle_status || "accepted").toLowerCase() === "accepted");
  const selectedCards = latestCardPerAuthor(cards);
  const humanCards = selectedCards.filter((card) => ["zac", "vivi"].includes(normalizeAuthor(card.author)));
  const deadlineAt = review.card_collection_deadline_at || event.card_collection_deadline_at;
  const deadlineReached = Boolean(deadlineAt && Date.now() >= new Date(deadlineAt).getTime());
  if (humanCards.length < 2 && !deadlineReached) return "pending";

  const missingAuthors = ["zac", "vivi"].filter((author) => !humanCards.some((card) => normalizeAuthor(card.author) === author));
  const resolution = review.resolution || await buildFinalResolution(event, selectedCards, humanCards, deadlineReached);
  if (!review.resolution) {
    await rejectL3ResolutionTasks(resolution, event, "human_event_finalize");
    await assignMaterializationIds(resolution);
    review.resolution = resolution;
    review.status = "materializing";
    review.human_card_ids = humanCards.map((card) => card.card_id);
    review.card_ids_by_author = Object.fromEntries(selectedCards.map((card) => [normalizeAuthor(card.author), card.card_id]));
    review.updated_at = new Date().toISOString();
    await writeJsonAtomic(reviewPath, review);
  }

  const topicIds = [];
  for (const decision of resolution.topics || []) {
    if (decision.status !== "approved") continue;
    const topic = await materializeTopic(decision, event, selectedCards, resolution.materialization.topics[decision.title]);
    topicIds.push(topic.topic_id);
  }

  const taskIds = [];
  for (const decision of resolution.tasks || []) {
    if (decision.status !== "approved") continue;
    const topic = await findTopicForTask(decision, event, topicIds);
    const assignment = resolution.materialization.tasks[decision.title];
    const task = await materializeTask(decision, event, topic, selectedCards, assignment.task_id, assignment.task_card_id);
    taskIds.push(task.task_id);
    await enqueueMaterializedTask(task, event);
    if (!task.owner_agent_id && task.task_kind !== "fanout_collection" && !task.owner_assignment_task_id) {
      const ownerAssignment = await createOwnerAssignmentTask(task, event);
      task.owner_assignment_task_id = ownerAssignment.task_id;
      task.updated_at = new Date().toISOString();
      await writeJsonAtomic(path.join(taskRecordsRoot, task.task_id, "task.json"), task);
      await appendJsonLine(path.join(taskRecordsRoot, task.task_id, "audit.jsonl"), { at: task.updated_at, type: "owner_assignment_created", assignment_task_id: ownerAssignment.task_id });
      await enqueueRelayTask(ownerAssignment);
    }
  }

  const needsReview = resolution.topics.some((item) => item.status === "need_review")
    || resolution.tasks.some((item) => item.status === "need_review");
  event.topic_ids = unique([...(event.topic_ids || []), ...topicIds]);
  event.task_ids = unique([...(event.task_ids || []), ...taskIds]);
  event.personal_card_ids = unique([...(event.personal_card_ids || []), ...selectedCards.map((card) => card.card_id)]);
  event.summary = resolution.summary || event.summary;
  event.key_points = resolution.key_points || event.key_points;
  event.summary_generated_at = resolution.generated_at;
  event.summary_card_ids = selectedCards.map((card) => card.card_id);
  event.method_entries = resolution.method_entries || [];
  event.memory_entries = resolution.memory_entries || [];
  event.missing_card_authors = missingAuthors;
  event.finalization_reason = humanCards.length >= 2 ? "all_cards" : "deadline";
  event.status = needsReview ? "need_review" : "materialized";
  event.summary_status = humanCards.length >= 2 ? "final" : "incomplete";
  event.updated_at = new Date().toISOString();
  await writeJsonAtomic(eventPath, event);
  review.status = needsReview ? "need_review" : "finalized";
  review.human_card_ids = humanCards.map((card) => card.card_id);
  review.consensus = resolution;
  review.missing_authors = missingAuthors;
  review.finalization_reason = event.finalization_reason;
  review.updated_at = new Date().toISOString();
  await writeJsonAtomic(reviewPath, review);
  await updateCardSubmissionTasks(review, humanCards, deadlineReached);
  if (needsReview) await createReviewTask(event, review, resolution);
  else await syncReviewTaskState(event.human_event_id, "completed", "all_candidates_resolved");
  await audit("human_event.finalized", { human_event_id: event.human_event_id, status: review.status, topic_count: topicIds.length, task_count: taskIds.length });
  return "finalized";
}

function latestCardPerAuthor(cards) {
  const latest = new Map();
  for (const card of [...cards].sort((a, b) => String(b.submitted_at || b.created_at).localeCompare(String(a.submitted_at || a.created_at)))) {
    const author = normalizeAuthor(card.author);
    if (["hermes", "zac", "vivi"].includes(author) && !latest.has(author)) latest.set(author, card);
  }
  return [...latest.values()];
}

function normalizeAuthor(value) {
  const author = String(value || "").trim().toLowerCase();
  if (author.includes("hermes")) return "hermes";
  if (author.includes("vivi")) return "vivi";
  if (author.includes("zac")) return "zac";
  return author;
}

async function buildFinalResolution(event, selectedCards, humanCards, deadlineReached) {
  const raw = process.env.PROJECT_HERMES_EVENT_TEST_FINALIZATION_JSON
    ? JSON.parse(process.env.PROJECT_HERMES_EVENT_TEST_FINALIZATION_JSON)
    : await askHermesForFinalResolution(event, selectedCards, humanCards, deadlineReached);
  const validHumanCardIds = new Set(humanCards.map((card) => card.card_id));
  const topics = mergeFinalDecisions(raw.topics, event.candidate_topics, "topic");
  const tasks = mergeFinalDecisions(raw.tasks, event.candidate_tasks, "task");
  for (const decision of [...topics, ...tasks]) {
    decision.supporting_card_ids = stringArray(decision.supporting_card_ids).filter((id) => validHumanCardIds.has(id));
    decision.opposing_card_ids = stringArray(decision.opposing_card_ids).filter((id) => validHumanCardIds.has(id));
    const supported = decision.supporting_card_ids.length > 0;
    const opposed = decision.opposing_card_ids.length > 0;
    if (decision.status === "rejected") continue;
    if (!humanCards.length || !supported || opposed) decision.status = "need_review";
    if (event.analysis_ref && decision.evidence_status !== "verified") {
      decision.status = "need_review";
      decision.reason = decision.reason || "Analysis candidate has no verified source evidence.";
    }
    if (event.analysis_ref && tasks.includes(decision) && !hasCompleteTaskDefinition(decision)) {
      decision.status = "need_review";
      decision.reason = decision.reason || "Task requires content, Topic, owner and done criteria before materialization.";
    }
  }
  return {
    mode: humanCards.length >= 2 ? "all_cards" : (humanCards.length === 1 ? "one_card_at_deadline" : "no_human_cards_at_deadline"),
    deadline_reached: deadlineReached,
    generated_at: new Date().toISOString(),
    summary: String(raw.summary || event.summary || "").trim(),
    key_points: normalizeSummaryPoints(raw.key_points).length
      ? normalizeSummaryPoints(raw.key_points)
      : (normalizeSummaryPoints(event.key_points).length
        ? normalizeSummaryPoints(event.key_points)
        : fallbackSummaryPoints(raw.summary || event.summary, event.title, 3)),
    topics,
    tasks,
    method_entries: normalizeMethodEntries(raw.method_entries, humanCards, event),
    memory_entries: normalizeMemoryEntries(raw.memory_entries, humanCards, event),
    materialization: { topics: {}, tasks: {} }
  };
}

function normalizeMethodEntries(rawEntries, humanCards, event) {
  const validCardIds = new Set(humanCards.map((card) => card.card_id));
  const accepted = [];
  for (const entry of Array.isArray(rawEntries) ? rawEntries : []) {
    const supportingCardIds = stringArray(entry?.supporting_card_ids).filter((id) => validCardIds.has(id));
    const opposingCardIds = stringArray(entry?.opposing_card_ids).filter((id) => validCardIds.has(id));
    const sourceRefs = stringArray(entry?.source_refs);
    const sourceFilesExist = sourceRefs.length > 0 && sourceRefs.every((sourceRef) => (
      /^https?:\/\//i.test(sourceRef) || existsSync(path.resolve(workspaceRoot, sourceRef))
    ));
    const evidence = normalizeCandidateEvidence(entry?.evidence);
    if (String(entry?.status || "").toLowerCase() !== "confirmed"
      || supportingCardIds.length === 0
      || opposingCardIds.length > 0
      || (event.analysis_ref && evidence.length === 0)
      || !sourceFilesExist) continue;
    const title = String(entry?.title || "").trim();
    const summary = String(entry?.summary || entry?.statement || "").trim();
    if (!title || !summary) continue;
    accepted.push({
      memory_id: String(entry?.memory_id || "").trim() || `memory-method-${normalizeSlug(title)}`,
      memory_type: "method",
      status: "confirmed",
      fact_status: "confirmed",
      evidence_type: entry?.evidence_type || "confirmed_human_event",
      title,
      summary,
      statement: summary,
      applicable_when: stringArray(entry?.applicable_when),
      not_applicable_when: stringArray(entry?.not_applicable_when),
      source_refs: sourceRefs,
      evidence,
      human_event_ids: [event.human_event_id],
      supporting_card_ids: supportingCardIds,
      opposing_card_ids: []
    });
  }
  return accepted;
}

function normalizeMemoryEntries(rawEntries, humanCards, event) {
  const validCardIds = new Set(humanCards.map((card) => card.card_id));
  const accepted = [];
  for (const entry of Array.isArray(rawEntries) ? rawEntries : []) {
    const supportingCardIds = stringArray(entry?.supporting_card_ids).filter((id) => validCardIds.has(id));
    const opposingCardIds = stringArray(entry?.opposing_card_ids).filter((id) => validCardIds.has(id));
    const sourceRefs = stringArray(entry?.source_refs);
    const status = String(entry?.status || "").toLowerCase();
    const sourceFilesExist = sourceRefs.length > 0 && sourceRefs.every((sourceRef) => (
      /^https?:\/\//i.test(sourceRef) || existsSync(path.resolve(workspaceRoot, sourceRef))
    ));
    const evidence = normalizeCandidateEvidence(entry?.evidence);
    if (status !== "confirmed"
      || supportingCardIds.length === 0
      || opposingCardIds.length > 0
      || (event.analysis_ref && evidence.length === 0)
      || !sourceFilesExist) continue;
    const normalized = {
      memory_id: String(entry?.memory_id || "").trim() || randomId("memory-", 8),
      memory_type: String(entry?.memory_type || "consensus").trim(),
      status: "confirmed",
      fact_status: "confirmed",
      evidence_type: entry?.evidence_type || "confirmed_human_event",
      statement: String(entry?.statement || "").trim(),
      source_refs: sourceRefs,
      evidence,
      human_event_ids: [event.human_event_id],
      supporting_card_ids: supportingCardIds,
      opposing_card_ids: []
    };
    if (normalized.statement) accepted.push(normalized);
  }
  return accepted.filter(Boolean);
}

function mergeFinalDecisions(rawItems, originalItems, kind) {
  const normalized = [];
  const seen = new Set();
  const originalsByTitle = new Map((originalItems || []).map((item) => [normalizeSlug(item.title), item]));
  for (const item of Array.isArray(rawItems) ? rawItems : []) {
    const title = String(item?.title || "").trim();
    if (!title || seen.has(normalizeSlug(title))) continue;
    const titleKey = normalizeSlug(title);
    const original = originalsByTitle.get(titleKey) || {};
    seen.add(titleKey);
    const requestedRisk = String(item?.risk_level || original.risk_level || "L1").toUpperCase();
    const decision = {
      task_id: kind === "task" ? String(item?.task_id || original.task_id || "").trim() : "",
      title,
      summary: String(item?.summary || original.summary || "").trim(),
      content: String(item?.content || item?.summary || original.content || original.summary || "").trim(),
      topic_title: String(item?.topic_title || item?.topic || original.topic_title || original.topic || "").trim(),
      owner: String(item?.owner || original.owner || "").trim(),
      coordination: item?.coordination || original.coordination || null,
      assignees: normalizeAssignees(item?.assignees || original.assignees),
      priority: String(item?.priority || original.priority || "medium").trim(),
      done_criteria: String(item?.done_criteria || original.done_criteria || item?.content || original.content || "").trim(),
      due_date: item?.due_date || original.due_date || null,
      risk_level: ["L0", "L1", "L2", "L3"].includes(requestedRisk) ? requestedRisk : "L1",
      status: normalizeDecisionStatus(item?.status),
      reason: String(item?.reason || "").trim(),
      supporting_card_ids: stringArray(item?.supporting_card_ids),
      opposing_card_ids: stringArray(item?.opposing_card_ids)
    };
    decision.evidence = normalizeCandidateEvidence(item?.evidence || original.evidence);
    decision.evidence_status = decision.evidence.length ? "verified" : "missing";
    if (decision.risk_level === "L3") {
      decision.status = "need_review";
      decision.reason = "L3 high-impact Tasks are prohibited and must be redesigned as L0-L2.";
    }
    normalized.push(decision);
  }
  for (const original of originalItems || []) {
    if (seen.has(normalizeSlug(original.title))) continue;
    normalized.push({
      ...original,
      status: "need_review",
      reason: `Hermes finalization did not explicitly resolve this ${kind}.`,
      supporting_card_ids: [],
      opposing_card_ids: []
    });
  }
  return normalized;
}

function hasCompleteTaskDefinition(task) {
  const hasOwner = String(task?.owner || "").trim() || (Array.isArray(task?.assignees) && task.assignees.length > 0);
  return Boolean(String(task?.content || "").trim()
    && String(task?.topic_title || "").trim()
    && hasOwner
    && String(task?.done_criteria || "").trim());
}

function normalizeCandidateEvidence(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    source_ref: String(item?.source_ref || "").trim(),
    line_start: Number(item?.line_start || 0),
    line_end: Number(item?.line_end || 0),
    excerpt_redacted: String(item?.excerpt_redacted || "").trim().slice(0, 200),
    verification: String(item?.verification || "").trim()
  })).filter((item) => item.source_ref
    && item.line_start > 0
    && item.line_end >= item.line_start
    && ["exact", "whitespace_normalized"].includes(item.verification));
}

async function assignMaterializationIds(resolution) {
  for (const topic of resolution.topics.filter((item) => item.status === "approved")) {
    const existing = await findExistingTopic(topic.title);
    resolution.materialization.topics[topic.title] = existing?.topic_id || randomId("topic-", 8);
  }
  for (const task of resolution.tasks.filter((item) => item.status === "approved")) {
    const topic = task.topic_title ? await findExistingTopic(task.topic_title) : null;
    const existing = await findExistingTask(task, topic);
    resolution.materialization.tasks[task.title] = existing
      ? { task_id: existing.task_id, task_card_id: existing.task_card_id, existing: true }
      : { task_id: randomId("task-", 8), task_card_id: randomId("", 8), existing: false };
  }
}

async function applyZacReview(reviewPath, review) {
  const eventPath = path.join(workspaceRoot, review.event_path);
  const event = await readJson(eventPath);
  const index = await readJson(path.join(cardsRoot, "card_index.json"), { cards: [] });
  const cards = (index.cards || []).filter((card) => card.human_event_id === review.human_event_id || card.event_id === review.human_event_id);
  const humanCards = cards.filter((card) => ["zac", "vivi"].includes(String(card.author || "").toLowerCase()));
  const decisions = review.manager_decisions || review.zac_decisions || review.decisions || {};
  const consensus = { mode: "zac_review", topics: normalizeDecisions(decisions.topics), tasks: normalizeDecisions(decisions.tasks) };
  const candidateTopics = review.resolution?.topics || event.candidate_topics || [];
  const candidateTasks = review.resolution?.tasks || event.candidate_tasks || [];
  for (const candidate of candidateTasks) {
    const decision = consensus.tasks.find((item) => item.title === candidate.title);
    if (!decision || decision.status !== "approved") continue;
    if (event.analysis_ref && (candidate.evidence_status !== "verified" || !hasCompleteTaskDefinition(candidate))) {
      decision.status = "need_review";
      decision.reason = event.analysis_ref && candidate.evidence_status !== "verified"
        ? "Analysis candidate has no verified source evidence."
        : "Task requires content, Topic, owner and done criteria before materialization.";
      continue;
    }
    const l3Decision = evaluateL3Request(candidate, l3Policy, { source: "human_event_zac_review" });
    if (!l3Decision.blocked) continue;
    decision.status = "rejected_l3";
    decision.reason = l3Decision.reasons.join(" ");
    decision.l3_rule_ids = l3Decision.rule_ids;
    decision.safe_alternatives = l3Decision.alternatives;
    await appendL3Audit(workspaceRoot, l3Policy, l3Decision, {
      human_event_id: event.human_event_id,
      action_ref: candidate.title
    });
  }
  review.zac_materialization = review.zac_materialization || { topics: {}, tasks: {} };
  for (const candidate of candidateTopics) {
    const decision = consensus.topics.find((item) => item.title === candidate.title);
    if (!decision || decision.status !== "approved" || review.zac_materialization.topics[candidate.title]) continue;
    if (event.analysis_ref && candidate.evidence_status !== "verified") {
      decision.status = "need_review";
      decision.reason = "Analysis candidate has no verified source evidence.";
      continue;
    }
    const existing = await findExistingTopic(candidate.title);
    review.zac_materialization.topics[candidate.title] = existing?.topic_id || randomId("topic-", 8);
  }
  for (const candidate of candidateTasks) {
    const decision = consensus.tasks.find((item) => item.title === candidate.title);
    if (!decision || decision.status !== "approved" || String(candidate.risk_level || "").toUpperCase() === "L3" || review.zac_materialization.tasks[candidate.title]) continue;
    if (event.analysis_ref && (candidate.evidence_status !== "verified" || !hasCompleteTaskDefinition(candidate))) continue;
    const topic = candidate.topic_title ? await findExistingTopic(candidate.topic_title) : null;
    const existing = await findExistingTask(candidate, topic);
    review.zac_materialization.tasks[candidate.title] = existing
      ? { task_id: existing.task_id, task_card_id: existing.task_card_id, existing: true }
      : { task_id: randomId("task-", 8), task_card_id: randomId("", 8), existing: false };
  }
  review.status = "zac_materializing";
  review.updated_at = new Date().toISOString();
  await writeJsonAtomic(reviewPath, review);
  const topicIds = [];
  for (const candidate of candidateTopics) {
    const decision = consensus.topics.find((item) => item.title === candidate.title);
    if (!decision || decision.status !== "approved") continue;
    const topic = await materializeTopic(candidate, event, humanCards, review.zac_materialization.topics[candidate.title]);
    topicIds.push(topic.topic_id);
  }
  const taskIds = [];
  for (const candidate of candidateTasks) {
    const decision = consensus.tasks.find((item) => item.title === candidate.title);
    if (!decision || decision.status !== "approved") continue;
    const topic = await findTopicForTask(candidate, event, topicIds);
    const assignmentIds = review.zac_materialization.tasks[candidate.title];
    const task = await materializeTask(candidate, event, topic, humanCards, assignmentIds.task_id, assignmentIds.task_card_id);
    taskIds.push(task.task_id);
    await enqueueMaterializedTask(task, event);
    if (!task.owner_agent_id && task.task_kind !== "fanout_collection" && !task.owner_assignment_task_id) {
      const assignment = await createOwnerAssignmentTask(task, event);
      task.owner_assignment_task_id = assignment.task_id;
      task.updated_at = new Date().toISOString();
      await writeJsonAtomic(path.join(taskRecordsRoot, task.task_id, "task.json"), task);
      await appendJsonLine(path.join(taskRecordsRoot, task.task_id, "audit.jsonl"), { at: task.updated_at, type: "owner_assignment_created", assignment_task_id: assignment.task_id });
      await enqueueRelayTask(assignment);
    }
  }
  event.topic_ids = unique([...(event.topic_ids || []), ...topicIds]);
  event.task_ids = unique([...(event.task_ids || []), ...taskIds]);
  event.status = "materialized";
  event.updated_at = new Date().toISOString();
  await writeJsonAtomic(eventPath, event);
  review.status = "finalized";
  review.review_status = "finalized";
  review.consensus = consensus;
  if (consensus.tasks.some((item) => item.status === "rejected_l3")) {
    review.l3_rejections = consensus.tasks
      .filter((item) => item.status === "rejected_l3")
      .map((item) => ({
        title: item.title,
        rule_ids: item.l3_rule_ids || [],
        alternatives: item.safe_alternatives || []
      }));
  }
  review.updated_at = event.updated_at;
  await writeJsonAtomic(reviewPath, review);
  await syncReviewTaskState(event.human_event_id, "completed", "manager_review_resolved");
  await audit("human_event.zac_review_resolved", { human_event_id: event.human_event_id, topic_count: topicIds.length, task_count: taskIds.length });
  return "finalized";
}

async function applyReviewTimeout(localTaskId) {
  const taskPath = path.join(taskRecordsRoot, localTaskId, "task.json");
  const task = await readJson(taskPath, null);
  if (!task || task.task_kind !== "human_event_review" || task.timeout_policy !== "default_no_objection") return false;
  if (["completed", "cancelled", "superseded"].includes(task.status)) return false;
  const eventId = (task.human_event_ids || [])[0] || "";
  const reviewPath = path.join(recordsRoot, eventId, "review.json");
  const review = await readJson(reviewPath, null);
  if (!review || !["need_review", "pending_zac_review", "materializing"].includes(review.status)) return false;
  const now = new Date().toISOString();
  const candidateTopics = review.resolution?.topics || [];
  const candidateTasks = review.resolution?.tasks || [];
  review.manager_decisions = {
    topics: candidateTopics.map((item) => ({ title: item.title, status: "approved", reason: "Review expired without an objection." })),
    tasks: candidateTasks.map((item) => ({
      title: item.title,
      status: String(item.risk_level || "").toUpperCase() === "L3" ? "rejected_l3" : "approved",
      reason: String(item.risk_level || "").toUpperCase() === "L3"
        ? "L3 remains prohibited and cannot be approved by silence."
        : "Review expired without an objection."
    }))
  };
  review.status = "resolved";
  review.review_status = "resolved";
  review.review_resolution = "timeout_assumed_no_objection";
  review.review_expired_at = now;
  review.updated_at = now;
  await writeJsonAtomic(reviewPath, review);
  task.status = "expired";
  task.expired_at = task.expired_at || now;
  task.review_resolution = "timeout_assumed_no_objection";
  task.updated_at = now;
  await writeJsonAtomic(taskPath, task);
  await appendJsonLine(path.join(taskRecordsRoot, localTaskId, "audit.jsonl"), {
    at: now,
    type: "review_expired_no_objection",
    task_id: localTaskId,
    human_event_id: eventId,
    status: "expired"
  });
  const queue = await readJson(queuePath, []);
  const queueItem = queue.find((item) => item.local_task_id === localTaskId);
  if (queueItem) {
    queueItem.status = "expired";
    queueItem.updated_at = now;
    await writeJsonAtomic(queuePath, queue);
  }
  await syncReviewTaskState(eventId, "expired", "timeout_assumed_no_objection");
  await audit("human_event.review_expired_no_objection", { human_event_id: eventId, task_id: localTaskId });
  return true;
}

async function applyExpiredReviewTasks() {
  for (const filePath of await walkFiles(taskRecordsRoot, (file) => path.basename(file) === "task.json")) {
    const task = await readJson(filePath, null);
    if (!task || task.task_kind !== "human_event_review" || task.timeout_policy !== "default_no_objection") continue;
    if (["completed", "cancelled", "superseded"].includes(task.status)) continue;
    const deadline = Date.parse(task.due_at || task.due_date || "");
    if (Number.isFinite(deadline) && deadline <= Date.now()) await applyReviewTimeout(task.task_id);
  }
}

async function syncReviewTaskMirrors() {
  const terminal = new Set(["completed", "expired", "cancelled", "superseded"]);
  for (const reviewTaskPath of await walkFiles(recordsRoot, (file) => path.basename(file) === "review-task.json")) {
    const mirror = await readJson(reviewTaskPath, null);
    if (!mirror?.task_id) continue;
    const task = await readJson(path.join(taskRecordsRoot, mirror.task_id, "task.json"), null);
    if (!task || !terminal.has(task.status) || mirror.status === task.status) continue;
    const now = new Date().toISOString();
    mirror.status = task.status;
    mirror.updated_at = now;
    if (task.status === "completed") {
      mirror.completion_reason = mirror.completion_reason || task.completion_reason || "review_task_completed";
      mirror.completed_at = mirror.completed_at || task.completed_at || now;
    }
    if (task.status === "expired") mirror.expired_at = mirror.expired_at || task.expired_at || now;
    await writeJsonAtomic(reviewTaskPath, mirror);
  }
}

async function resolveConsensus(event, humanCards) {
  if (humanCards.length === 1) {
    return {
      mode: "one_card_confirmed",
      topics: (event.candidate_topics || []).map((item) => ({ title: item.title, status: "approved", reason: "One human card confirms; the other is not confirmed and has not opposed." })),
      tasks: (event.candidate_tasks || []).map((item) => ({ title: item.title, status: "approved", reason: "One human card confirms; the other is not confirmed and has not opposed." }))
    };
  }
  const prompt = [
    "You are Project Hermes resolving a meeting review.",
    "A candidate is approved when both cards agree, or one card confirms it and the other does not oppose it.",
    "Only explicit conflict, rejection, or an unresolved semantic contradiction goes to Zac.",
    "Return JSON only with topics and tasks. Preserve candidate titles exactly.",
    JSON.stringify({ event: { title: event.title, summary: event.summary, candidates: { topics: event.candidate_topics, tasks: event.candidate_tasks } }, cards: humanCards.map((card) => ({ author: card.author, title: card.title, key_points: card.key_points, conclusions: card.conclusions, next_steps: card.next_steps, excerpt: card.excerpt })) }, null, 2),
    JSON.stringify({ topics: [{ title: "candidate title", status: "approved|rejected|need_review", reason: "short reason" }], tasks: [{ title: "candidate title", status: "approved|rejected|need_review", reason: "short reason" }] })
  ].join("\n\n");
  const raw = await runHermes(prompt, "consensus");
  const parsed = parseJsonObject(raw);
  return {
    mode: "two_card_review",
    topics: normalizeDecisions(parsed.topics),
    tasks: normalizeDecisions(parsed.tasks)
  };
}

async function askHermesForFinalResolution(event, selectedCards, humanCards, deadlineReached) {
  const sourceMaterial = [];
  let remaining = maxSourceChars;
  for (const sourceRef of event.source_refs || []) {
    if (remaining <= 0) break;
    try {
      const content = await fs.readFile(path.join(workspaceRoot, sourceRef), "utf8");
      const text = content.slice(0, remaining);
      remaining -= text.length;
      sourceMaterial.push({ source_ref: sourceRef, content: text });
    } catch {
      sourceMaterial.push({ source_ref: sourceRef, content: "[source unavailable]" });
    }
  }
  const prompt = [
    "You are Project Hermes finalizing one Human Event.",
    "Write the overall Human Event summary from the original source and the latest Personal Card from each author.",
    "Resolve both the initial candidates and any new Topic/Task proposed by a human card.",
    "A Topic or Task may be approved only when at least one Zac/Vivi card explicitly supports it and no Zac/Vivi card opposes it.",
    "If both human cards exist, one explicit confirmation plus silence from the other is sufficient. Explicit conflict, rejection, no human confirmation, or ambiguity requires Zac review.",
    "Use exact card_id values in supporting_card_ids and opposing_card_ids. Never list the Hermes card as human support.",
    "Only emit method_entries for reusable methods explicitly supported by at least one Zac/Vivi Personal Card, with no opposing human card.",
    "A method_entry is not a project rule, a one-off action, a hypothesis, or a person stereotype. Do not emit it unless the evidence shows a reusable method and an applicable scope.",
    "Only emit memory_entries for stable facts or consensus explicitly confirmed by at least one Zac/Vivi Personal Card, with no opposing human card.",
    "Do not put summaries, hypotheses, candidate Topics/Tasks, provisional or incomplete conclusions, or Hermes-only inferences in memory_entries.",
    "Every memory entry must have status=confirmed, fact_status=confirmed, a non-empty statement, an allowed evidence_type, real source_refs, and exact supporting_card_ids. Leave uncertain items out of memory_entries and keep them in Topic/Task review.",
    "Memory is file-based project memory. Never write a guess as a fact. A later explicit human correction may supersede an existing Memory record.",
    "Tasks must use L0, L1, or L2. Never propose or approve L3.",
    "Return exactly one JSON object and do not modify files.",
    JSON.stringify({
      summary: "overall Human Event summary",
      key_points: ["final point"],
      topics: [{ title: "Topic", summary: "current summary", status: "approved|rejected|need_review", reason: "evidence", supporting_card_ids: ["card id"], opposing_card_ids: [] }],
      tasks: [{ task_id: "existing task id or empty", title: "Task", content: "action", topic_title: "Topic", owner: "Zac Codex|Vivi Codex|", done_criteria: "verifiable result", due_date: null, risk_level: "L1", coordination: null, assignees: [], status: "approved|rejected|need_review", reason: "evidence", supporting_card_ids: ["card id"], opposing_card_ids: [] }],
      method_entries: [{ memory_id: "existing method memory id or empty", title: "Reusable method", summary: "what the method does", applicable_when: ["scope"], not_applicable_when: [], status: "confirmed", fact_status: "confirmed", evidence_type: "confirmed_human_event", source_refs: ["workspace-relative source path"], supporting_card_ids: ["human card id"], opposing_card_ids: [] }],
      memory_entries: [{ memory_id: "stable-memory-id-or-empty", memory_type: "consensus|person_profile|dictionary|project_identity|project_context", status: "confirmed", fact_status: "confirmed", evidence_type: "human_statement|human_correction|confirmed_human_event|authority_pointer", statement: "explicitly confirmed fact", source_refs: ["workspace-relative source path"], supporting_card_ids: ["human card id"], opposing_card_ids: [] }]
    }, null, 2),
    "Context:",
    JSON.stringify({
      human_event: {
        human_event_id: event.human_event_id,
        type: event.type,
        title: event.title,
        provisional_summary: event.summary,
        candidate_topics: event.candidate_topics,
        candidate_tasks: event.candidate_tasks,
        method_candidates: event.method_candidates || [],
        deadline_reached: deadlineReached,
        human_card_count: humanCards.length
      },
      cards: selectedCards.map((card) => ({
        card_id: card.card_id,
        author: card.author,
        title: card.title,
        key_points: card.key_points,
        perspectives: card.perspectives,
        conclusions: card.conclusions,
        next_steps: card.next_steps,
        card_text: String(card.card_text || card.excerpt || "").slice(0, 20000)
      })),
      sources: sourceMaterial
    }, null, 2)
  ].join("\n\n");
  return parseJsonObject(await runHermes(prompt, "finalization"));
}

async function updateCardSubmissionTasks(review, humanCards, deadlineReached) {
  const queue = await readJson(queuePath, []);
  let queueChanged = false;
  for (const taskId of review.card_submission_task_ids || []) {
    const taskPath = path.join(taskRecordsRoot, taskId, "task.json");
    const task = await readJson(taskPath, null);
    if (!task) continue;
    const author = normalizeAuthor(task.owner);
    const card = humanCards.find((item) => normalizeAuthor(item.author) === author);
    const previousEvidence = task.submission_card_id || null;
    const previousStatus = task.status;
    if (card) {
      task.submission_status = "received";
      task.submission_card_id = card.card_id;
      task.submission_card_path = card.card_path;
      if (task.status !== "expired") {
        task.status = "completed";
        task.completed_at = task.completed_at || new Date().toISOString();
        task.completion_summary = "Personal Card 已在派发前或派发后收到并通过校验。";
        const queueItem = queue.find((item) => item.local_task_id === task.task_id);
        if (queueItem && queueItem.status !== "completed") {
          queueItem.status = "completed";
          queueItem.updated_at = task.completed_at;
          queueChanged = true;
        }
      }
    } else if (deadlineReached && !["completed", "expired"].includes(task.status)) {
      task.status = "expired";
      task.expired_at = new Date().toISOString();
      task.submission_status = "missing_at_deadline";
      const queueItem = queue.find((item) => item.local_task_id === task.task_id);
      if (queueItem && queueItem.status !== "completed") {
        queueItem.status = "expired";
        queueItem.updated_at = task.expired_at;
        queueChanged = true;
      }
    }
    if (previousEvidence !== (task.submission_card_id || null) || previousStatus !== task.status) {
      task.updated_at = new Date().toISOString();
      await writeJsonAtomic(taskPath, task);
      await appendJsonLine(path.join(taskRecordsRoot, taskId, "audit.jsonl"), {
        at: task.updated_at,
        type: card ? "card_received" : "expired",
        task_id: taskId,
        card_id: card?.card_id || null,
        status: task.status
      });
    }
  }
  if (queueChanged) await writeJsonAtomic(queuePath, queue);
}

async function materializeTopic(candidate, event, cards, forcedTopicId = "") {
  const existing = await findExistingTopic(candidate.title);
  const topicId = existing?.topic_id || forcedTopicId || randomId("topic-", 8);
  const topicDir = path.join(topicsRoot, topicId);
  const topicCards = cards.filter((card) => card.topic_id === topicId);
  const record = {
    schema_version: 1,
    topic_id: topicId,
    title: candidate.title,
    current_summary: candidate.summary,
    human_event_ids: unique([...(existing?.human_event_ids || []), event.human_event_id]),
    personal_card_ids: unique([...(existing?.personal_card_ids || []), ...topicCards.map((card) => card.card_id)]),
    task_ids: existing?.task_ids || [],
    source_refs: unique([...(existing?.source_refs || []), ...event.source_refs]),
    status: existing?.status || "active",
    created_at: existing?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await writeJsonAtomic(path.join(topicDir, "topic.json"), record);
  return record;
}

async function findExistingTopic(title) {
  for (const filePath of await walkFiles(topicsRoot, (file) => path.basename(file) === "topic.json")) {
    const topic = await readJson(filePath, null);
    if (topic && normalizeSlug(topic.title) === normalizeSlug(title)) return topic;
  }
  return null;
}

async function findTopicForTask(candidate, event, topicIds) {
  const title = candidate.topic_title || candidate.topic || "";
  if (title) {
    const existing = await findExistingTopic(title);
    if (existing) return existing;
    return null;
  }
  if (topicIds.length !== 1) return null;
  const files = await walkFiles(topicsRoot, (file) => path.basename(file) === "topic.json");
  for (const filePath of files) {
    const topic = await readJson(filePath, null);
    if (topic && topicIds.includes(topic.topic_id)) return topic;
  }
  return null;
}

async function materializeTask(candidate, event, topic, cards, forcedTaskId = "", forcedTaskCardId = "") {
  await assertL3Allowed(workspaceRoot, candidate, {
    policy: l3Policy,
    source: "human_event_task_materialization",
    audit: {
      human_event_id: event.human_event_id,
      action_ref: topic?.topic_id || `human-event:${event.human_event_id}`
    }
  });
  const requestedRisk = String(candidate.risk_level || "L1").toUpperCase();
  if (Array.isArray(candidate.assignees) && candidate.assignees.length) {
    const fanout = await createFanoutCollection(workspaceRoot, {
      task_id: forcedTaskId,
      task_card_id: forcedTaskCardId,
      title: candidate.title,
      content: candidate.content,
      topic_id: topic?.topic_id || null,
      human_event_ids: [event.human_event_id],
      source_refs: unique([...event.source_refs, ...cards.flatMap((card) => card.source_refs || [])]),
      input_artifacts: normalizeInputArtifacts(candidate.input_artifacts),
      done_criteria: candidate.done_criteria || candidate.content,
      due_at: candidate.due_date || null,
      priority: candidate.priority || "medium",
      risk_level: requestedRisk,
      origin_ref: `human-event:${event.human_event_id}:topic:${topic?.topic_id || "unassigned"}`,
      assignees: candidate.assignees
    });
    if (topic && fanout.parent?.task_id) {
      topic.task_ids = unique([...(topic.task_ids || []), ...(fanout.task_ids || [fanout.parent.task_id])]);
      topic.updated_at = new Date().toISOString();
      await writeJsonAtomic(path.join(topicsRoot, topic.topic_id, "topic.json"), topic);
    }
    return fanout.parent;
  }
  const taskId = forcedTaskId || randomId("task-", 8);
  const existing = await readJson(path.join(taskRecordsRoot, taskId, "task.json"), null);
  if (existing) return updateExistingTask(existing, candidate, event, topic, cards);
  const owner = normalizeOwner(candidate.owner);
  const task = {
    schema_version: 1,
    task_id: taskId,
    task_kind: "topic_task",
    title: candidate.title,
    content: candidate.content,
    topic_id: topic?.topic_id || null,
    human_event_ids: [event.human_event_id],
    owner: owner.name,
    owner_agent_id: owner.agent_id,
    status: owner.agent_id ? "ready" : "pending_owner",
    due_date: candidate.due_date || null,
    done_criteria: candidate.done_criteria || candidate.content,
    risk_level: ["L0", "L1", "L2"].includes(requestedRisk) ? requestedRisk : "L1",
    task_card_id: forcedTaskCardId || randomId("", 8),
    source_refs: unique([...event.source_refs, ...cards.flatMap((card) => card.source_refs || [])]),
    input_artifacts: normalizeInputArtifacts(candidate.input_artifacts),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  const taskDir = path.join(taskRecordsRoot, taskId);
  await fs.mkdir(taskDir, { recursive: true, mode: 0o2775 });
  await writeJsonAtomic(path.join(taskDir, "task.json"), task);
  await appendJsonLine(path.join(taskDir, "audit.jsonl"), { at: task.created_at, type: "created", task_id: taskId, status: task.status, owner: task.owner });
  await writeTaskCard(task, event, topic);
  if (topic) {
    topic.task_ids = unique([...(topic.task_ids || []), taskId]);
    topic.updated_at = new Date().toISOString();
    await writeJsonAtomic(path.join(topicsRoot, topic.topic_id, "topic.json"), topic);
  }
  return task;
}

async function rejectL3ResolutionTasks(resolution, event, source) {
  resolution.l3_rejections = resolution.l3_rejections || [];
  for (const task of resolution.tasks || []) {
    const decision = evaluateL3Request(task, l3Policy, { source });
    if (!decision.blocked) continue;
    task.status = "rejected_l3";
    task.reason = decision.reasons.join(" ");
    task.l3_rule_ids = decision.rule_ids;
    task.safe_alternatives = decision.alternatives;
    resolution.l3_rejections.push({
      title: task.title,
      rule_ids: decision.rule_ids,
      alternatives: decision.alternatives
    });
    await appendL3Audit(workspaceRoot, l3Policy, decision, {
      human_event_id: event.human_event_id,
      action_ref: task.title
    });
  }
}

async function findExistingTask(candidate, topic) {
  const tasks = [];
  for (const filePath of await walkFiles(taskRecordsRoot, (file) => path.basename(file) === "task.json")) {
    const task = await readJson(filePath, null);
    if (task?.task_id) tasks.push(task);
  }
  if (candidate.task_id) return tasks.find((task) => task.task_id === candidate.task_id) || null;
  if (!topic?.topic_id) return null;
  const titleKey = normalizeSlug(candidate.title);
  return tasks.find((task) => ["topic_task", "fanout_collection"].includes(task.task_kind)
    && task.topic_id === topic.topic_id
    && normalizeSlug(task.title) === titleKey) || null;
}

async function updateExistingTask(task, candidate, event, topic, cards) {
  const now = new Date().toISOString();
  const owner = normalizeOwner(candidate.owner);
  task.human_event_ids = unique([...(task.human_event_ids || []), event.human_event_id]);
  task.source_refs = unique([...(task.source_refs || []), ...event.source_refs, ...cards.flatMap((card) => card.source_refs || [])]);
  task.input_artifacts = normalizeInputArtifacts([...(task.input_artifacts || []), ...normalizeInputArtifacts(candidate.input_artifacts)]);
  if (candidate.content) task.content = candidate.content;
  if (candidate.done_criteria) task.done_criteria = candidate.done_criteria;
  if (candidate.due_date) task.due_date = candidate.due_date;
  if (!task.owner_agent_id && owner.agent_id) {
    task.owner = owner.name;
    task.owner_agent_id = owner.agent_id;
    if (task.status === "pending_owner") task.status = "ready";
  }
  task.updated_at = now;
  await writeJsonAtomic(path.join(taskRecordsRoot, task.task_id, "task.json"), task);
  await appendJsonLine(path.join(taskRecordsRoot, task.task_id, "audit.jsonl"), {
    at: now,
    type: "discussed_in_human_event",
    task_id: task.task_id,
    human_event_id: event.human_event_id,
    source_card_ids: cards.map((card) => card.card_id),
    status: task.status
  });
  if (task.task_card_id) await writeTaskCard(task, event, topic);
  return task;
}


async function createOwnerAssignmentTask(task, event) {
  return createLocalTask({
    task_kind: "owner_assignment",
    title: "确认 Task 负责人：" + task.title,
    content: `请为 Task ${task.task_id} 确认 Zac Codex 或 Vivi Codex 的负责人，并将 owner_agent_id 写入 09-tasks/tasks/${task.task_id}/task.json。`,
    owner: manager.person,
    target_agent_id: manager.agent_id,
    human_event_ids: [event.human_event_id],
    done_criteria: `Task ${task.task_id} 已有明确负责人，并更新了对应 task.json。`,
    source_refs: task.source_refs,
    due_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
    priority: "high",
    risk_level: "L1"
  });
}

async function createLocalTask(input) {
  const result = await createProjectTask(workspaceRoot, input);
  return result.task;
}

async function writeTaskCard(task, event, topic) {
  const cardPath = path.join(cardsRoot, "cards", `card-${task.task_card_id}.md`);
  const lines = [
    "---",
    `card_id: ${task.task_card_id}`,
    `card_type: task`,
    `task_id: ${task.task_id}`,
    `human_event_id: ${event.human_event_id}`,
    `topic_id: ${topic?.topic_id || ""}`,
    "placement_type: topic",
    `placement_id: ${topic?.topic_id || ""}`,
    "author: Hermes",
    `occurred_at: ${task.created_at}`,
    `title: ${JSON.stringify(task.title)}`,
    "participants:",
    `  - ${task.owner || "未分配"}`,
    "---",
    "",
    `# ${task.title}`,
    "",
    "## 任务内容",
    `- ${task.content}`,
    "",
    "## 当前状态",
    `- ${task.status}`,
    "",
    ...(task.input_artifacts?.length ? [
      "## 输入材料",
      ...task.input_artifacts.map((artifact) => `- [${artifact.title}](${artifact.url || artifact.path})（${artifact.artifact_id}，SHA-256: ${artifact.sha256 || "未记录"}）`),
      ""
    ] : []),
    "## 完成标准",
    `- ${task.done_criteria}`,
    ""
  ];
  await fs.writeFile(cardPath, lines.join("\n"), { mode: 0o664 });
}

async function createReviewTask(event, review, consensus) {
  const existing = (await readJson(path.join(path.dirname(reviewPathFor(event)), "review-task.json"), null));
  if (existing && !["completed", "expired", "cancelled", "superseded"].includes(existing.status)) return existing;
  const reviewScope = {
    topics: (consensus.topics || []).filter((item) => item.status === "need_review"),
    tasks: (consensus.tasks || []).filter((item) => item.status === "need_review")
  };
  const task = await createLocalTask({
    task_kind: "human_event_review",
    title: `Review 交流记录：${event.title}`,
    content: `请审查交流记录 ${event.human_event_id} 中存在分歧或未确认的项目议题/Task，并决定确认、修改或拒绝。已经终态拒绝的候选不进入 Review。\n\n${JSON.stringify(reviewScope, null, 2)}`,
    owner: manager.person,
    target_agent_id: manager.agent_id,
    task_role: "manager_review",
    manager_role: manager.role,
    review_status: "need_review",
    human_event_ids: [event.human_event_id],
    done_criteria: "将 review.json 的 status 改为 resolved，并写入 manager_decisions: topics/tasks 中每项使用 { title, status: approved|rejected|need_review }。",
    source_refs: event.source_refs,
    due_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(),
    timeout_policy: "default_no_objection",
    priority: "high",
    risk_level: "L1"
  });
  await enqueueRelayTask(task);
  await writeJsonAtomic(path.join(path.dirname(reviewPathFor(event)), "review-task.json"), task);
  review.review_task_id = task.task_id;
  review.manager = manager;
  review.status = "need_review";
  review.updated_at = new Date().toISOString();
  await writeJsonAtomic(reviewPathFor(event), review);
  return task;
}

async function syncReviewTaskState(humanEventId, requestedStatus, reason) {
  const reviewTaskPath = path.join(recordsRoot, humanEventId, "review-task.json");
  const mirror = await readJson(reviewTaskPath, null);
  if (!mirror) return;
  const taskPath = path.join(taskRecordsRoot, mirror.task_id || "", "task.json");
  const task = mirror.task_id ? await readJson(taskPath, null) : null;
  const terminal = ["completed", "expired", "cancelled", "superseded"];
  const now = new Date().toISOString();
  const actualStatus = task && terminal.includes(task.status) ? task.status : requestedStatus;
  if (task && task.status !== actualStatus) {
    task.status = actualStatus;
    task.updated_at = now;
    if (actualStatus === "completed") {
      task.completed_at = task.completed_at || now;
      task.completion_reason = reason;
    }
    if (actualStatus === "expired") task.expired_at = task.expired_at || now;
    await writeJsonAtomic(taskPath, task);
    await appendJsonLine(path.join(path.dirname(taskPath), "audit.jsonl"), {
      at: now,
      type: "review_task_state_synced",
      task_id: task.task_id,
      status: actualStatus,
      reason
    });
  }
  mirror.status = actualStatus;
  mirror.updated_at = now;
  mirror.completion_reason = actualStatus === "completed" ? reason : (mirror.completion_reason || null);
  if (actualStatus === "completed") mirror.completed_at = mirror.completed_at || now;
  if (actualStatus === "expired") mirror.expired_at = mirror.expired_at || now;
  await writeJsonAtomic(reviewTaskPath, mirror);
  const queue = await readJson(queuePath, []);
  const item = queue.find((entry) => entry.local_task_id === mirror.task_id);
  if (item && terminal.includes(actualStatus)) {
    item.status = actualStatus;
    item.updated_at = now;
    await writeJsonAtomic(queuePath, queue);
  }
}

function reviewPathFor(event) {
  return path.join(recordsRoot, event.human_event_id, "review.json");
}

async function enqueueRelayTask(task) {
  await enqueueProjectTask(workspaceRoot, task);
}

async function enqueueMaterializedTask(task, event) {
  if (task.task_kind !== "fanout_collection") {
    if (task.owner_agent_id) await enqueueRelayTask(task);
    return;
  }
  const children = await Promise.all((task.assignee_task_ids || []).map((taskId) => readJson(
    path.join(taskRecordsRoot, taskId, "task.json"),
    null
  )));
  for (const child of children.filter(Boolean)) await enqueueRelayTask(child);
  await appendJsonLine(path.join(taskRecordsRoot, task.task_id, "audit.jsonl"), {
    at: new Date().toISOString(),
    type: "children_enqueued",
    child_task_ids: children.filter(Boolean).map((child) => child.task_id),
    human_event_id: event.human_event_id
  });
}

async function renderTaskIndex() {
  await renderRegistryTaskIndex(workspaceRoot);
}

async function rebuildIndexes() {
  await import(`./render-card-index.mjs?pipeline=${Date.now()}`);
}

async function askHermes(intakePath, intake, sourceText) {
  if (process.env.PROJECT_HERMES_EVENT_TEST_PROPOSAL_JSON) {
    return JSON.parse(process.env.PROJECT_HERMES_EVENT_TEST_PROPOSAL_JSON);
  }
  const existingTopics = [];
  for (const filePath of await walkFiles(topicsRoot, (file) => path.basename(file) === "topic.json")) {
    const topic = await readJson(filePath, null);
    if (topic) existingTopics.push({ topic_id: topic.topic_id, title: topic.title, summary: topic.current_summary });
  }
  const proposalPath = path.join(path.dirname(intakePath), "proposal.json");
  const proposalRelativePath = relativePath(workspaceRoot, proposalPath);
  const diagnostics = {
    proposal_path: proposalRelativePath,
    primary_model: extractionModel,
    final_model: extractionModel,
    fallback_reason: null,
    started_at: new Date().toISOString(),
    attempts: []
  };

  if (intake.proposal_ready === true) {
    try {
      const proposal = validateProposal(await readJsonObjectFile(proposalPath));
      diagnostics.attempts.push({ source: "prepared_proposal", ok: true });
      diagnostics.final_model = "prepared_proposal";
      diagnostics.parse_attempts = diagnostics.attempts.length;
      diagnostics.completed_at = new Date().toISOString();
      await persistProposalDiagnostics(intakePath, intake, diagnostics);
      return proposal;
    } catch (error) {
      diagnostics.attempts.push({ source: "prepared_proposal", ok: false, error: String(error.message || error) });
    }
  } else {
    await fs.rm(proposalPath, { force: true });
  }

  const schemaExample = JSON.stringify({
    title: "Human Event title",
    occurred_at: "ISO timestamp",
    participants: ["Zac", "Vivi"],
    summary: "initial Human Event summary",
    key_points: ["short point"],
    topics: [{ title: "Topic title", summary: "current topic summary" }],
    tasks: [{ task_id: "existing task id or empty", title: "Task title", content: "concrete action", topic_title: "Topic title", owner: "Zac Codex", done_criteria: "verifiable result", due_date: null, risk_level: "L1" }]
  }, null, 2);
  const prompt = [
    "You are Project Hermes, the project manager for collab_workspace.",
    `This material is a ${intake.human_event_type === "chat" ? "chat import" : "formal meeting transcript"}.`,
    "Create a Human Event proposal with an initial summary. Extract Topics and concrete Tasks, but do not modify files.",
    "A Topic is a subject discussed by people. A Task is one concrete action that implements a Topic.",
    "Tasks must have title, content, owner (Zac Codex, Vivi Codex, or empty), done_criteria, optional due_date, and risk_level L0/L1/L2. Never propose L3.",
    "A fan-out collection Task may include coordination.type=fanout_collection and assignees with name, agent_id, title, content, done_criteria. Hermes remains coordinator; only assignee Tasks are dispatched.",
    "When the material explicitly references an existing Task, preserve its task_id. Otherwise leave task_id empty; do not invent an ID.",
    "Return exactly one JSON object on stdout. Do not call tools, skill_view, or modify project files.",
    `If the runtime cannot return JSON on stdout, the only permitted file output is ${proposalRelativePath}.`,
    "JSON schema example:",
    schemaExample,
    "Existing Topics:",
    JSON.stringify(existingTopics, null, 2),
    `Original filename: ${intake.original_filename}`,
    `Submitted at: ${intake.submitted_at}`,
    "Source material:",
    sourceText.slice(0, maxSourceChars)
  ].join("\n\n");
  const firstRun = await runHermesCapture(prompt, "proposal", hermesMaxTurns);
  diagnostics.first_run = summarizeHermesRun(firstRun);
  const stdoutProposal = tryProposal(firstRun.stdout, "stdout", diagnostics);
  if (stdoutProposal) {
    return acceptOrEscalateProposal(stdoutProposal, "stdout", prompt, proposalPath, intakePath, intake, diagnostics);
  }

  try {
    const fileProposal = validateProposal(await readJsonObjectFile(proposalPath));
    diagnostics.attempts.push({ source: "proposal_file", ok: true });
    return acceptOrEscalateProposal(fileProposal, "proposal_file", prompt, proposalPath, intakePath, intake, diagnostics);
  } catch (error) {
    diagnostics.attempts.push({ source: "proposal_file", ok: false, error: String(error.message || error) });
  }

  const repairPrompt = [
    "Repair the following Human Event proposal into exactly one valid JSON object.",
    "Return JSON only. Do not call tools, skills, or write files.",
    "Tasks may only use risk_level L0, L1, or L2; L3 is prohibited.",
    "Required schema example:",
    schemaExample,
    "Invalid model output:",
    firstRun.stdout.slice(0, 30000)
  ].join("\n\n");
  const repairRun = await runHermesCapture(repairPrompt, "proposal-repair", 1, "no_mcp");
  diagnostics.repair_run = summarizeHermesRun(repairRun);
  const repairedProposal = tryProposal(repairRun.stdout, "repair_stdout", diagnostics);
  if (repairedProposal) {
    return acceptOrEscalateProposal(repairedProposal, "repair_stdout", prompt, proposalPath, intakePath, intake, diagnostics);
  }

  if (extractionModel !== decisionModel) {
    return runDecisionProposalFallback("flash_output_invalid", prompt, proposalPath, intakePath, intake, diagnostics);
  }

  diagnostics.parse_attempts = diagnostics.attempts.length;
  diagnostics.completed_at = new Date().toISOString();
  await persistProposalDiagnostics(intakePath, intake, diagnostics);
  const reasons = diagnostics.attempts.filter((attempt) => !attempt.ok).map((attempt) => `${attempt.source}: ${attempt.error}`).join("; ");
  throw new Error(`Hermes proposal parsing failed (${reasons})`);
}

async function acceptOrEscalateProposal(proposal, source, prompt, proposalPath, intakePath, intake, diagnostics) {
  if (extractionModel !== decisionModel && proposal.tasks.some((task) => String(task.risk_level || "").toUpperCase() === "L2")) {
    return runDecisionProposalFallback("l2_candidate_requires_decision_model", prompt, proposalPath, intakePath, intake, diagnostics);
  }
  diagnostics.accepted_source = source;
  diagnostics.final_model = extractionModel;
  diagnostics.parse_attempts = diagnostics.attempts.length;
  diagnostics.completed_at = new Date().toISOString();
  await persistProposalDiagnostics(intakePath, intake, diagnostics);
  return proposal;
}

async function runDecisionProposalFallback(reason, prompt, proposalPath, intakePath, intake, diagnostics) {
  const targetModel = reason === "l2_candidate_requires_decision_model" ? decisionModel : fallbackModel;
  diagnostics.fallback_reason = reason;
  diagnostics.final_model = targetModel;
  await fs.rm(proposalPath, { force: true });
  const fallbackRun = await runHermesCapture(prompt, "proposal-fallback", hermesMaxTurns, null, targetModel);
  diagnostics.fallback_run = summarizeHermesRun(fallbackRun);
  let proposal = tryProposal(fallbackRun.stdout, "fallback_stdout", diagnostics);
  if (!proposal) {
    try {
      proposal = validateProposal(await readJsonObjectFile(proposalPath));
      diagnostics.attempts.push({ source: "fallback_proposal_file", ok: true });
    } catch (error) {
      diagnostics.attempts.push({ source: "fallback_proposal_file", ok: false, error: String(error.message || error) });
    }
  }
  diagnostics.parse_attempts = diagnostics.attempts.length;
  diagnostics.completed_at = new Date().toISOString();
  await persistProposalDiagnostics(intakePath, intake, diagnostics);
  if (proposal) return proposal;
  const reasons = diagnostics.attempts.filter((attempt) => !attempt.ok).map((attempt) => `${attempt.source}: ${attempt.error}`).join("; ");
  throw new Error(`Hermes proposal fallback failed (${reasons})`);
}

async function runHermes(prompt, label) {
  const result = await runHermesCapture(prompt, label, hermesMaxTurns);
  if (result.timed_out) throw new Error(`Hermes ${label} timed out after ${hermesTimeoutMs}ms`);
  if (result.code !== 0) throw new Error(`Hermes ${label} exited ${result.code}: ${result.stderr.slice(-800)}`);
  return result.stdout;
}

async function runHermesCapture(prompt, label, maxTurns, toolsets = null, modelOverride = null) {
  const model = modelOverride || (["consensus", "finalization"].includes(label) ? decisionModel : extractionModel);
  return runHermesCommand({
    command: hermesCommand,
    prompt,
    cwd: workspaceRoot,
    env: { ...process.env, AGENTRELAY_TASK_ADAPTER: `project-hermes-human-event-${label}`, AGENTRELAY_AGENT_ID: "project-hermes" },
    maxTurns,
    timeoutMs: hermesTimeoutMs,
    toolsets,
    model,
    provider: modelProvider
  });
}

function tryProposal(text, source, diagnostics) {
  try {
    const proposal = validateProposal(parseJsonObject(text));
    diagnostics.attempts.push({ source, ok: true });
    return proposal;
  } catch (error) {
    diagnostics.attempts.push({ source, ok: false, error: String(error.message || error), raw_output: String(text || "").slice(0, 20000) });
    return null;
  }
}

async function persistProposalDiagnostics(intakePath, intake, diagnostics) {
  intake.proposal_diagnostics = diagnostics;
  intake.updated_at = new Date().toISOString();
  await writeJsonAtomic(intakePath, intake);
}

function summarizeHermesRun(run) {
  return {
    code: run.code,
    model: run.model,
    provider: run.provider,
    latency_ms: run.latency_ms,
    timed_out: Boolean(run.timed_out),
    stderr: String(run.stderr || "").slice(-4000)
  };
}

function validateProposal(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("proposal must be a JSON object");
  if (!String(raw.title || "").trim()) throw new Error("proposal.title is required");
  if (!raw.occurred_at || Number.isNaN(new Date(raw.occurred_at).getTime())) throw new Error("proposal.occurred_at must be a valid timestamp");
  if (!Array.isArray(raw.participants)) throw new Error("proposal.participants must be an array");
  if (!String(raw.summary || "").trim()) throw new Error("proposal.summary is required");
  if (!Array.isArray(raw.key_points)) throw new Error("proposal.key_points must be an array");
  if (!Array.isArray(raw.topics)) throw new Error("proposal.topics must be an array");
  if (!Array.isArray(raw.tasks)) throw new Error("proposal.tasks must be an array");
  for (const topic of raw.topics) {
    if (!String(topic?.title || "").trim()) throw new Error("every proposal Topic requires title");
  }
  for (const task of raw.tasks) {
    if (!String(task?.title || "").trim() || !String(task?.content || "").trim()) throw new Error("every proposal Task requires title and content");
    if (!String(task?.topic_title || task?.topic || "").trim()) throw new Error(`Task ${task.title} requires topic_title`);
    if (!String(task?.done_criteria || "").trim()) throw new Error(`Task ${task.title} requires done_criteria`);
    const risk = String(task?.risk_level || "").toUpperCase();
    if (!["L0", "L1", "L2"].includes(risk)) throw new Error(`Task ${task.title} has prohibited or invalid risk_level ${risk || "missing"}`);
    if (task.assignees !== undefined && !Array.isArray(task.assignees)) throw new Error(`Task ${task.title} assignees must be an array`);
    for (const assignee of task.assignees || []) {
      if (!String(assignee?.name || assignee?.owner || "").trim() || !String(assignee?.agent_id || assignee?.target_agent_id || "").trim()) {
        throw new Error(`Task ${task.title} fan-out assignees require name and agent_id`);
      }
      if (String(assignee?.risk_level || "L1").toUpperCase() === "L3") throw new Error(`Task ${task.title} contains prohibited L3 assignee`);
    }
  }
  return raw;
}

function normalizeProposal(raw) {
  const type = String(raw?.type || "").toLowerCase();
  return {
    title: String(raw?.title || "未命名 Human Event").trim().slice(0, 160),
    occurred_at: normalizeDate(raw?.occurred_at),
    participants: stringArray(raw?.participants),
    agent_participants: stringArray(raw?.agent_participants),
    system_actors: stringArray(raw?.system_actors),
    source_actor_names: stringArray(raw?.source_actor_names || raw?.participants),
    started_at: raw?.started_at ? normalizeDate(raw.started_at) : normalizeDate(raw?.occurred_at),
    ended_at: raw?.ended_at ? normalizeDate(raw.ended_at) : null,
    summary: String(raw?.summary || "").trim(),
    key_points: normalizeSummaryPoints(raw?.key_points).length
      ? normalizeSummaryPoints(raw?.key_points)
      : fallbackSummaryPoints(raw?.summary || raw?.title, raw?.title, 3),
    topics: (Array.isArray(raw?.topics) ? raw.topics : []).map((item) => ({ title: String(item?.title || "").trim(), summary: String(item?.summary || "").trim() })).filter((item) => item.title),
    tasks: (Array.isArray(raw?.tasks) ? raw.tasks : []).map((item) => ({
      task_id: String(item?.task_id || "").trim(),
      title: String(item?.title || "").trim(),
      content: String(item?.content || "").trim(),
      topic_title: String(item?.topic_title || item?.topic || "").trim(),
      owner: String(item?.owner || "").trim(),
      done_criteria: String(item?.done_criteria || item?.content || "").trim(),
      due_date: item?.due_date || null,
      risk_level: String(item?.risk_level || "L1").toUpperCase(),
      coordination: item?.coordination || null,
      assignees: normalizeAssignees(item?.assignees),
      priority: String(item?.priority || "medium").trim()
    })).filter((item) => item.title && item.content),
    type: type === "chat" ? "chat" : "meeting"
  };
}

function normalizeDecisions(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    title: String(item?.title || "").trim(),
    status: normalizeDecisionStatus(item?.status),
    reason: String(item?.reason || "").trim()
  })).filter((item) => item.title);
}

function normalizeDecisionStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (["approved", "rejected", "rejected_l3", "need_review"].includes(status)) return status;
  if (["needs_zac_review", "pending_zac_review", "review", "unknown", "unresolved"].includes(status)) return "need_review";
  return "need_review";
}

function normalizeOwner(owner) {
  const value = String(owner || "").toLowerCase();
  if (value.includes("vivi")) return { name: "Vivi Codex", agent_id: "vivi-agent" };
  if (value.includes("zac")) return { name: "Zac Codex", agent_id: "zac-agent" };
  return { name: "", agent_id: null };
}

function isAnalysisV2(value) {
  const version = Number(value);
  return Number.isFinite(version) && version >= 2 && version < 3;
}

function normalizeAssignees(value) {
  return (Array.isArray(value) ? value : []).map((item) => ({
    name: String(item?.name || item?.owner || "").trim(),
    agent_id: String(item?.agent_id || item?.target_agent_id || "").trim(),
    title: String(item?.title || "").trim(),
    content: String(item?.content || "").trim(),
    done_criteria: String(item?.done_criteria || "").trim(),
    risk_level: String(item?.risk_level || "L1").toUpperCase()
  })).filter((item) => item.name && item.agent_id);
}

function stringArray(value) {
  if (!Array.isArray(value)) return value ? [String(value).trim()].filter(Boolean) : [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeDate(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

async function findEventReviews() {
  return walkFiles(recordsRoot, (filePath) => path.basename(filePath) === "review.json");
}

async function audit(event, detail) {
  await appendJsonLine(pipelineLog, { at: new Date().toISOString(), event, ...detail });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : String(process.argv[index + 1] || "");
}
