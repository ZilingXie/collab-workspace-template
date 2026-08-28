#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendJsonLine,
  arrayValue,
  extractDate,
  extractSectionItems,
  extractTitle,
  getWorkspaceRoot,
  isTextFile,
  normalizeSlug,
  parseFrontmatter,
  randomId,
  readJson,
  relativePath,
  unique,
  walkFiles,
  writeJsonAtomic
} from "./card-v1-lib.mjs";
import { loadProjectHermesModelConfig, parseJsonObject, runHermesCommand } from "./hermes-structured-output.mjs";
import { createProjectTask, enqueueProjectTask } from "./task-registry.mjs";
import { loadProjectRoles, projectManager } from "./project-roles.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = getWorkspaceRoot(scriptDirectory);
const manager = projectManager(await loadProjectRoles(workspaceRoot));
const cardsRoot = path.join(workspaceRoot, "08-cards");
const inboxes = [
  { owner: "zac", path: path.join(cardsRoot, "inbox", "zac-draft") },
  { owner: "vivi", path: path.join(cardsRoot, "inbox", "vivi-draft") }
];
const routingRoot = path.join(cardsRoot, "draft-routing");
const processingRoot = path.join(routingRoot, "processing");
const reviewRoot = path.join(cardsRoot, "review");
const recordsRoot = path.join(cardsRoot, "human-events", "records");
const topicsRoot = path.join(cardsRoot, "topics");
const tasksRoot = path.join(workspaceRoot, "09-tasks");
const taskRecordsRoot = path.join(tasksRoot, "tasks");
const queuePath = path.join(tasksRoot, "dispatch_queue.json");
const logPath = path.join(cardsRoot, "ingestion_log.jsonl");
const hermesCommand = process.env.PROJECT_HERMES_COMMAND || "hermes";
const hermesMaxTurns = Number(process.env.PROJECT_HERMES_DRAFT_MAX_TURNS || 4);
const hermesTimeoutMs = Number(process.env.PROJECT_HERMES_DRAFT_TIMEOUT_MS || 600000);
const maxSourceChars = Number(process.env.PROJECT_HERMES_DRAFT_MAX_SOURCE_CHARS || 60000);
const modelConfig = loadProjectHermesModelConfig();
const modelProvider = modelConfig.provider || process.env.PROJECT_HERMES_MODEL_PROVIDER || "deepseek";
const decisionModel = modelConfig.decision_model || process.env.PROJECT_HERMES_DECISION_MODEL || "deepseek-v4-pro";
const fallbackModel = modelConfig.fallback_model || process.env.PROJECT_HERMES_FALLBACK_MODEL || decisionModel;
const flashEnabledValue = modelConfig.flash_enabled ?? process.env.PROJECT_HERMES_FLASH_ENABLED ?? "1";
const flashEnabled = !["0", "false", "no", "off"].includes(String(flashEnabledValue).toLowerCase());
const routingModel = flashEnabled
  ? (modelConfig.routing_model || modelConfig.extraction_model || process.env.PROJECT_HERMES_ROUTING_MODEL || process.env.PROJECT_HERMES_EXTRACTION_MODEL || "deepseek-v4-flash")
  : decisionModel;

await ensureDirectories();
let routed = 0;
let reviewed = 0;
let failed = 0;

await processResolvedReviews();
await claimUnboundDrafts();
for (const intakePath of await walkFiles(processingRoot, (filePath) => path.basename(filePath) === "intake.json")) {
  try {
    const intake = await readJson(intakePath);
    if (["archived", "review", "ignored"].includes(intake.status)) continue;
    const result = await routeDraft(intakePath, intake);
    if (result === "review") reviewed += 1;
    else routed += 1;
  } catch (error) {
    failed += 1;
    const intake = await readJson(intakePath, {});
    intake.status = "retry";
    intake.last_error = String(error.message || error);
    intake.updated_at = new Date().toISOString();
    await writeJsonAtomic(intakePath, intake);
    await audit("draft_routing.failed", { ingest_id: intake.ingest_id, error: intake.last_error });
  }
}

console.log(JSON.stringify({ ok: failed === 0, routed, reviewed, failed, workspace: workspaceRoot }, null, 2));
if (failed) process.exitCode = 1;

async function ensureDirectories() {
  for (const dir of [processingRoot, ...inboxes.map((item) => item.path), reviewRoot, recordsRoot, topicsRoot, taskRecordsRoot, path.join(cardsRoot, "cards"), path.join(cardsRoot, "contents")]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o2775 });
  }
}

async function claimUnboundDrafts() {
  for (const inbox of inboxes) {
    for (const filePath of await walkFiles(inbox.path, isTextFile)) {
      const parsed = parseFrontmatter(await fs.readFile(filePath, "utf8"));
      const humanEventId = String(parsed.data.human_event_id || "").trim();
      if (humanEventId && await exists(path.join(recordsRoot, humanEventId, "event.json"))) continue;
      const ingestId = randomId("draft-", 8);
      const intakeDir = path.join(processingRoot, ingestId);
      await fs.mkdir(intakeDir, { recursive: true, mode: 0o2775 });
      const destination = path.join(intakeDir, path.basename(filePath));
      const stats = await fs.stat(filePath);
      await fs.rename(filePath, destination);
      await writeJsonAtomic(path.join(intakeDir, "intake.json"), {
        schema_version: 1,
        ingest_id: ingestId,
        owner: inbox.owner,
        original_filename: path.basename(filePath),
        source_path: relativePath(workspaceRoot, destination),
        submitted_at: stats.mtime.toISOString(),
        status: "claimed",
        attempts: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      await audit("draft_routing.claimed", { ingest_id: ingestId, owner: inbox.owner, original_filename: path.basename(filePath) });
    }
  }
}

async function routeDraft(intakePath, intake) {
  const sourcePath = path.join(workspaceRoot, intake.source_path);
  const sourceText = await fs.readFile(sourcePath, "utf8");
  intake.attempts = Number(intake.attempts || 0) + 1;
  const proposal = normalizeProposal(await askHermes(intakePath, intake, sourceText));
  proposal.body = parseFrontmatter(sourceText).body.trim();
  if (proposal.route === "human_event" && proposal.human_event_id && !(await readHumanEvent(proposal.human_event_id))) {
    proposal.route = "review";
    proposal.uncertainty_reason = `Human Event ${proposal.human_event_id} does not exist.`;
  }
  intake.proposal = proposal;
  intake.updated_at = new Date().toISOString();
  await writeJsonAtomic(intakePath, intake);
  if (proposal.route === "review") {
    await moveToReview(intakePath, intake, sourcePath, proposal);
    return "review";
  }
  if (proposal.route === "ignore") {
    await archiveSource(intakePath, intake, sourcePath, path.join(cardsRoot, "legacy", "ignored"), "draft-ignore");
    intake.status = "ignored";
    intake.updated_at = new Date().toISOString();
    await writeJsonAtomic(intakePath, intake);
    return "ignored";
  }
  if (proposal.route === "topic") await commitTopicDraft(intakePath, intake, sourcePath, proposal);
  else await commitHumanEventDraft(intakePath, intake, sourcePath, proposal);
  return proposal.route;
}

async function commitHumanEventDraft(intakePath, intake, sourcePath, proposal) {
  let event = proposal.human_event_id ? await readHumanEvent(proposal.human_event_id) : null;
  const now = new Date().toISOString();
  if (!event) {
    const humanEventId = randomId("he-", 8);
    const eventDir = path.join(recordsRoot, humanEventId);
    const sourceDestination = path.join(eventDir, "sources", "card-submissions", intake.owner, `${intake.ingest_id}-${path.basename(sourcePath)}`);
    await fs.mkdir(path.dirname(sourceDestination), { recursive: true, mode: 0o2775 });
    await fs.rename(sourcePath, sourceDestination);
    const sourceRef = relativePath(workspaceRoot, sourceDestination);
    event = {
      schema_version: 1,
      human_event_id: humanEventId,
      type: proposal.event_type || "meeting",
      title: proposal.event_title || proposal.title,
      occurred_at: proposal.occurred_at,
      participants: unique([...(proposal.participants || []), displayOwner(intake.owner)]),
      source_refs: [sourceRef],
      summary_status: "provisional",
      summary: proposal.summary,
      key_points: proposal.key_points,
      candidate_topics: proposal.candidate_topics,
      candidate_tasks: proposal.candidate_tasks,
      topic_ids: [],
      task_ids: [],
      personal_card_ids: [],
      card_collection_deadline_at: null,
      status: "pending_human_review",
      created_at: now,
      updated_at: now
    };
    await fs.mkdir(eventDir, { recursive: true, mode: 0o2775 });
    await writeJsonAtomic(path.join(eventDir, "event.json"), event);
    const hermesCardId = await writePersonalCard(event, "Hermes", event.source_refs[0], proposal, now);
    event.personal_card_ids.push(hermesCardId);
    await writeJsonAtomic(path.join(eventDir, "event.json"), event);
    await createEventReview(event, event.source_refs[0], now);
    sourcePath = sourceDestination;
  }
  const cardSourceRef = await moveEventSource(event, intake, sourcePath);
  event.source_refs = unique([...(event.source_refs || []), cardSourceRef]);
  const cardId = await writePersonalCard(event, displayOwner(intake.owner), cardSourceRef, proposal, now);
  event.personal_card_ids = unique([...(event.personal_card_ids || []), cardId]);
  event.updated_at = now;
  await writeJsonAtomic(path.join(recordsRoot, event.human_event_id, "event.json"), event);
  await registerHumanEventCard(event, intake, cardId, now);
  await archiveIntake(intakePath, intake, cardId, event.human_event_id, now);
}

async function commitTopicDraft(intakePath, intake, sourcePath, proposal) {
  const existing = proposal.topic_id ? await readTopic(proposal.topic_id) : await findTopicByTitle(proposal.topic_title || proposal.title);
  const topicId = existing?.topic_id || randomId("topic-", 8);
  const topicDir = path.join(topicsRoot, topicId);
  const now = new Date().toISOString();
  const sourceDestination = path.join(topicDir, "sources", `${intake.ingest_id}-${path.basename(sourcePath)}`);
  await fs.mkdir(path.dirname(sourceDestination), { recursive: true, mode: 0o2775 });
  await fs.rename(sourcePath, sourceDestination);
  const sourceRef = relativePath(workspaceRoot, sourceDestination);
  const cardId = randomId("", 8);
  const cardTitle = proposal.title || proposal.topic_title || "未命名 Topic 材料";
  await writeCardAndContent(cardId, {
    event_id: topicId,
    topic_id: topicId,
    author: displayOwner(intake.owner),
    occurred_at: proposal.occurred_at || intake.submitted_at,
    submitted_at: intake.submitted_at,
    title: cardTitle,
    participants: proposal.participants || [displayOwner(intake.owner)],
    source_refs: [sourceRef],
    body: proposal.body
  });
  const topic = {
    schema_version: 1,
    topic_id: topicId,
    title: existing?.title || proposal.topic_title || proposal.title,
    current_summary: proposal.summary || existing?.current_summary || "",
    human_event_ids: existing?.human_event_ids || [],
    personal_card_ids: unique([...(existing?.personal_card_ids || []), cardId]),
    task_ids: existing?.task_ids || [],
    source_refs: unique([...(existing?.source_refs || []), sourceRef, `08-cards/cards/card-${cardId}.md`]),
    status: existing?.status || "active",
    created_at: existing?.created_at || now,
    updated_at: now
  };
  await writeJsonAtomic(path.join(topicDir, "topic.json"), topic);
  await archiveIntake(intakePath, intake, cardId, "", now);
}

async function createEventReview(event, sourceRef, now) {
  const reviewPath = path.join(recordsRoot, event.human_event_id, "review.json");
  const review = {
    schema_version: 1,
    review_id: randomId("review-", 8),
    human_event_id: event.human_event_id,
    event_path: relativePath(workspaceRoot, path.join(recordsRoot, event.human_event_id, "event.json")),
    type: event.type,
    status: "pending_cards",
    card_submission_task_ids: [],
    human_card_ids: [],
    card_ids_by_author: {},
    expected_authors: ["hermes", "zac", "vivi"],
    card_collection_deadline_at: null,
    consensus: null,
    created_at: now,
    updated_at: now
  };
  for (const person of [{ key: "zac", agent: "zac-agent", name: "Zac" }, { key: "vivi", agent: "vivi-agent", name: "Vivi" }]) {
    const task = await createCardSubmissionTask(event, person, now);
    review.card_submission_task_ids.push(task.task_id);
  }
  await writeJsonAtomic(reviewPath, review);
}

async function createCardSubmissionTask(event, person, now) {
  const result = await createProjectTask(workspaceRoot, {
    task_kind: "card_submission",
    title: `提交交流记录卡片：${event.title}`,
    content: `请为交流记录 ${event.human_event_id} 提交 Personal Card，文件放入 08-cards/inbox/${person.key}-draft/，并填写 human_event_id: ${event.human_event_id}、card_type: personal、author: ${person.name}。`,
    owner: person.name,
    target_agent_id: person.agent,
    human_event_ids: [event.human_event_id],
    done_criteria: `Personal Card 已写入 08-cards/inbox/${person.key}-draft/，并包含正确的 human_event_id 与 author。`,
    source_refs: event.source_refs || [],
    priority: "medium",
    risk_level: "L0",
    created_at: now
  }, { enqueue: true });
  return result.task;
}

async function registerHumanEventCard(event, intake, cardId, now) {
  const reviewPath = path.join(recordsRoot, event.human_event_id, "review.json");
  const review = await readJson(reviewPath, null);
  if (!review) return;
  const owner = normalizePerson(intake.owner);
  review.human_card_ids = unique([...(review.human_card_ids || []), cardId]);
  review.card_ids_by_author = { ...(review.card_ids_by_author || {}), [owner]: cardId };
  if (review.status === "finalized") review.status = "pending_cards";
  review.updated_at = now;
  await writeJsonAtomic(reviewPath, review);
  for (const taskId of review.card_submission_task_ids || []) {
    const taskPath = path.join(taskRecordsRoot, taskId, "task.json");
    const task = await readJson(taskPath, null);
    if (!task || normalizePerson(task.owner) !== owner || task.status === "completed") continue;
    task.status = "completed";
    task.submission_card_id = cardId;
    task.completed_at = now;
    task.updated_at = now;
    await writeJsonAtomic(taskPath, task);
    await appendJsonLine(path.join(path.dirname(taskPath), "audit.jsonl"), { at: now, type: "card_received_before_dispatch", task_id: taskId, card_id: cardId, status: task.status });
    await markQueueComplete(taskId, now);
  }
}

async function writePersonalCard(event, author, sourceRef, proposal, now) {
  const cardId = randomId("", 8);
  await writeCardAndContent(cardId, {
    event_id: event.human_event_id,
    human_event_id: event.human_event_id,
    author,
    occurred_at: proposal.occurred_at || event.occurred_at,
    submitted_at: now,
    title: proposal.title || event.title,
    participants: proposal.participants || event.participants,
    source_refs: [sourceRef],
    body: proposal.body || renderProposalBody(proposal)
  });
  return cardId;
}

async function writeCardAndContent(cardId, data) {
  const cardPath = path.join(cardsRoot, "cards", `card-${cardId}.md`);
  const contentPath = path.join(cardsRoot, "contents", `content-${cardId}.md`);
  const lines = [
    "---", `card_id: ${cardId}`, `content_id: ${cardId}`, `event_id: ${data.event_id || ""}`,
    ...(data.human_event_id ? [`human_event_id: ${data.human_event_id}`] : []),
    ...(data.topic_id ? [`topic_id: ${data.topic_id}`] : []),
    "card_type: personal", `author: ${data.author}`, `occurred_at: ${data.occurred_at}`,
    `submitted_at: ${data.submitted_at}`, `title: ${JSON.stringify(data.title)}`, "participants:",
    ...(data.participants || []).map((person) => `  - ${person}`), "source_refs:",
    ...(data.source_refs || []).map((ref) => `  - ${ref}`), "---", "", data.body || "# " + data.title, ""
  ];
  await fs.writeFile(cardPath, lines.join("\n"), { mode: 0o664 });
  await fs.writeFile(contentPath, String(data.body || "# " + data.title).trim() + "\n", { mode: 0o664 });
}

async function moveEventSource(event, intake, sourcePath) {
  const destination = path.join(recordsRoot, event.human_event_id, "sources", "card-submissions", intake.owner, `${intake.ingest_id}-${path.basename(sourcePath)}`);
  if (path.basename(sourcePath).startsWith(`${intake.ingest_id}-`) && path.dirname(sourcePath) === path.dirname(destination)) {
    return relativePath(workspaceRoot, sourcePath);
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o2775 });
  if (sourcePath !== destination) await fs.rename(sourcePath, destination);
  return relativePath(workspaceRoot, destination);
}

async function archiveIntake(intakePath, intake, cardId, eventId, now) {
  intake.status = "archived";
  intake.card_id = cardId;
  intake.human_event_id = eventId || undefined;
  intake.archived_at = now;
  intake.updated_at = now;
  await writeJsonAtomic(intakePath, intake);
  await audit("draft_routing.archived", { ingest_id: intake.ingest_id, owner: intake.owner, card_id: cardId, human_event_id: eventId || "" });
}

async function moveToReview(intakePath, intake, sourcePath, proposal) {
  const reviewDir = path.join(reviewRoot, intake.owner, "draft-routing", intake.ingest_id);
  await fs.mkdir(reviewDir, { recursive: true, mode: 0o2775 });
  const reviewSource = path.join(reviewDir, path.basename(sourcePath));
  await fs.rename(sourcePath, reviewSource);
  const reviewPath = path.join(reviewDir, "review.json");
  const review = {
    schema_version: 1,
    review_kind: "draft_routing",
    ingest_id: intake.ingest_id,
    submitted_by: intake.owner,
    owner: manager.person,
    owner_agent_id: manager.agent_id,
    manager,
    original_filename: intake.original_filename,
    submitted_at: intake.submitted_at,
    source_path: relativePath(workspaceRoot, reviewSource),
    status: "pending_dispatch",
    decision: null,
    question: "请确认材料应关联哪个 Human Event 或 Topic；若没有，请填写新的标题。完成后将 review.json 的 status 改为 resolved，并填写 decision 与对应 ID。",
    proposal,
    updated_at: new Date().toISOString(),
    created_at: intake.created_at
  };
  await writeJsonAtomic(reviewPath, review);
  const task = await createClarificationTask(review, reviewPath);
  review.task_id = task.task_id;
  await writeJsonAtomic(reviewPath, review);
  intake.status = "review";
  intake.review_path = relativePath(workspaceRoot, reviewPath);
  intake.updated_at = review.updated_at;
  await writeJsonAtomic(intakePath, intake);
  await audit("draft_routing.review", { ingest_id: intake.ingest_id, owner: intake.owner, review_path: intake.review_path, task_id: task.task_id });
}

async function createClarificationTask(review, reviewPath) {
  const result = await createProjectTask(workspaceRoot, {
    task_kind: "draft_routing_clarification",
    task_role: "manager_review",
    manager_role: manager.role,
    review_status: "need_review",
    title: `确认材料归属：${review.proposal.title || review.original_filename}`,
    content: `${review.question}\n\nReview 文件：${relativePath(workspaceRoot, reviewPath)}`,
    owner: manager.person,
    target_agent_id: manager.agent_id,
    origin_ref: `draft-review:${review.ingest_id}`,
    done_criteria: `已更新 ${relativePath(workspaceRoot, reviewPath)}，status=resolved，并明确 decision 为 human_event、topic 或 ignore。`,
    human_event_ids: [],
    source_refs: [relativePath(workspaceRoot, reviewPath)],
    priority: "high",
    risk_level: "L1"
  }, { enqueue: true });
  return result.task;
}

async function enqueueTask(task) {
  await enqueueProjectTask(workspaceRoot, task);
}

async function markQueueComplete(taskId, now) {
  const queue = await readJson(queuePath, []);
  const item = queue.find((entry) => entry.local_task_id === taskId);
  if (!item) return;
  item.status = "completed";
  item.updated_at = now;
  await writeJsonAtomic(queuePath, queue);
}

async function processResolvedReviews() {
  const reviewFiles = await walkFiles(reviewRoot, (filePath) => path.basename(filePath) === "review.json");
  for (const reviewPath of reviewFiles) {
    const review = await readJson(reviewPath, null);
    if (!review || review.review_kind !== "draft_routing" || review.status !== "resolved") continue;
    const sourcePath = path.join(workspaceRoot, review.source_path || "");
    if (!(await exists(sourcePath))) continue;
    const intakeDir = path.join(processingRoot, review.ingest_id);
    await fs.mkdir(intakeDir, { recursive: true, mode: 0o2775 });
    const destination = path.join(intakeDir, path.basename(sourcePath));
    await fs.rename(sourcePath, destination);
    const intakePath = path.join(intakeDir, "intake.json");
    await writeJsonAtomic(intakePath, {
      schema_version: 1,
      ingest_id: review.ingest_id,
      owner: review.submitted_by || review.owner,
      original_filename: review.original_filename,
      source_path: relativePath(workspaceRoot, destination),
      submitted_at: review.submitted_at,
      status: "claimed",
      proposal: { ...(review.proposal || {}), ...(review.resolution || {}), route: review.decision },
      created_at: review.created_at,
      updated_at: new Date().toISOString()
    });
    review.status = "processing";
    review.updated_at = new Date().toISOString();
    await writeJsonAtomic(reviewPath, review);
  }
}

async function askHermes(intakePath, intake, sourceText) {
  if (process.env.PROJECT_HERMES_DRAFT_TEST_PROPOSAL_JSON) return JSON.parse(process.env.PROJECT_HERMES_DRAFT_TEST_PROPOSAL_JSON);
  const catalog = await routingCatalog();
  const prompt = [
    "You are Project Hermes routing a Zac/Vivi draft material.",
    "The draft is not yet a Card. Decide where it belongs before generating a Personal Card.",
    "Route human_event when it describes a meeting or human-to-human interaction; route topic when it is a standalone project judgment, progress, or topic update.",
    "Use an existing ID only when the match is clear. If uncertain, return review.",
    "Return JSON only:",
    JSON.stringify({
      route: "human_event|topic|review|ignore",
      human_event_id: "existing id or empty",
      topic_id: "existing id or empty",
      event_type: "meeting|chat",
      event_title: "new Human Event title",
      topic_title: "new or matched Topic title",
      title: "concise Personal Card title",
      occurred_at: "ISO date/time",
      participants: ["Zac", "Vivi"],
      summary: "one sentence",
      key_points: ["point"],
      candidate_topics: [{ title: "Topic", summary: "summary" }],
      candidate_tasks: [{ title: "Task", content: "action", owner: "Zac Codex|Vivi Codex|", done_criteria: "verifiable", risk_level: "L1" }],
      uncertainty_reason: "why review is needed"
    }, null, 2),
    "Submitter: " + intake.owner,
    "Existing Human Events and Topics:",
    JSON.stringify(catalog, null, 2),
    "Source:", sourceText.slice(0, maxSourceChars)
  ].join("\n\n");
  const diagnostics = {
    primary_model: routingModel,
    final_model: routingModel,
    fallback_reason: null,
    started_at: new Date().toISOString(),
    attempts: []
  };
  const firstRun = await runHermes(prompt, routingModel, hermesMaxTurns);
  diagnostics.first_run = summarizeModelRun(firstRun);
  let raw = tryRoutingJson(firstRun.stdout, "stdout", diagnostics);

  if (!raw) {
    const repairPrompt = [
      "Repair the following Draft Router response into exactly one valid JSON object.",
      "Return JSON only. Do not call tools or write files.",
      prompt,
      "Invalid output:",
      firstRun.stdout.slice(0, 20000)
    ].join("\n\n");
    const repairRun = await runHermes(repairPrompt, routingModel, 1, "no_mcp");
    diagnostics.repair_run = summarizeModelRun(repairRun);
    raw = tryRoutingJson(repairRun.stdout, "repair_stdout", diagnostics);
  }

  const fallbackReason = raw ? await routingFallbackReason(raw) : "flash_output_invalid";
  if (routingModel !== decisionModel && fallbackReason) {
    diagnostics.fallback_reason = fallbackReason;
    const targetModel = fallbackReason === "l2_candidate_requires_decision_model" ? decisionModel : fallbackModel;
    diagnostics.final_model = targetModel;
    const fallbackRun = await runHermes(prompt, targetModel, hermesMaxTurns);
    diagnostics.fallback_run = summarizeModelRun(fallbackRun);
    raw = tryRoutingJson(fallbackRun.stdout, "fallback_stdout", diagnostics);
  }

  diagnostics.parse_attempts = diagnostics.attempts.length;
  diagnostics.completed_at = new Date().toISOString();
  intake.model_diagnostics = diagnostics;
  intake.updated_at = new Date().toISOString();
  await writeJsonAtomic(intakePath, intake);
  if (!raw) throw new Error("Hermes Draft Router did not return valid JSON after model fallback");
  return raw;
}

async function routingFallbackReason(raw) {
  const proposal = normalizeProposal(raw);
  if (proposal.route === "review") return "ambiguous_route_requires_decision_model";
  if (proposal.candidate_tasks.some((task) => String(task?.risk_level || "").toUpperCase() === "L2")) return "l2_candidate_requires_decision_model";
  if (proposal.human_event_id && !(await readHumanEvent(proposal.human_event_id))) return "invalid_human_event_reference";
  if (proposal.topic_id && !(await readTopic(proposal.topic_id))) return "invalid_topic_reference";
  return null;
}

function tryRoutingJson(text, source, diagnostics) {
  try {
    const raw = parseJsonObject(text);
    diagnostics.attempts.push({ source, ok: true });
    return raw;
  } catch (error) {
    diagnostics.attempts.push({ source, ok: false, error: String(error.message || error), raw_output: String(text || "").slice(0, 12000) });
    return null;
  }
}

function summarizeModelRun(run) {
  return {
    code: run.code,
    model: run.model,
    provider: run.provider,
    latency_ms: run.latency_ms,
    timed_out: Boolean(run.timed_out),
    stderr: String(run.stderr || "").slice(-2000)
  };
}

function normalizeProposal(raw) {
  let route = String(raw?.route || "").toLowerCase();
  if (!["human_event", "topic", "review", "ignore"].includes(route)) {
    if (raw?.topic_id || raw?.topic_title) route = "topic";
    else if (raw?.human_event_id || raw?.event_title || raw?.event_id) route = "human_event";
    else route = "review";
  }
  return {
    route,
    human_event_id: String(raw?.human_event_id || "").trim(),
    topic_id: String(raw?.topic_id || "").trim(),
    event_type: raw?.event_type === "chat" ? "chat" : "meeting",
    event_title: String(raw?.event_title || "").trim(),
    topic_title: String(raw?.topic_title || "").trim(),
    title: String(raw?.title || raw?.event_title || raw?.topic_title || "未命名材料").trim().slice(0, 160),
    occurred_at: normalizeDate(raw?.occurred_at),
    participants: stringArray(raw?.participants),
    summary: String(raw?.summary || "").trim(),
    key_points: stringArray(raw?.key_points),
    candidate_topics: Array.isArray(raw?.candidate_topics) ? raw.candidate_topics : [],
    candidate_tasks: Array.isArray(raw?.candidate_tasks) ? raw.candidate_tasks : [],
    uncertainty_reason: String(raw?.uncertainty_reason || "").trim(),
    body: ""
  };
}

async function routingCatalog() {
  const events = await walkFiles(recordsRoot, (filePath) => path.basename(filePath) === "event.json");
  const topics = await walkFiles(topicsRoot, (filePath) => path.basename(filePath) === "topic.json");
  return {
    human_events: await Promise.all(events.map(async (filePath) => {
      const event = await readJson(filePath, {});
      return { human_event_id: event.human_event_id, title: event.title, occurred_at: event.occurred_at, participants: event.participants || [] };
    })),
    topics: await Promise.all(topics.map(async (filePath) => {
      const topic = await readJson(filePath, {});
      return { topic_id: topic.topic_id, title: topic.title, current_summary: topic.current_summary || "" };
    }))
  };
}

async function readHumanEvent(id) {
  return id ? readJson(path.join(recordsRoot, id, "event.json"), null) : null;
}

async function readTopic(id) {
  return id ? readJson(path.join(topicsRoot, id, "topic.json"), null) : null;
}

async function findTopicByTitle(title) {
  if (!title) return null;
  for (const filePath of await walkFiles(topicsRoot, (filePath) => path.basename(filePath) === "topic.json")) {
    const topic = await readJson(filePath, null);
    if (topic && normalizeSlug(topic.title) === normalizeSlug(title)) return topic;
  }
  return null;
}

function renderProposalBody(proposal) {
  return [
    `# ${proposal.title}`,
    "",
    "## 卡片要点",
    ...(proposal.key_points.length ? proposal.key_points.map((item) => `- ${item}`) : ["- NA"]),
    "",
    "## 当前结论",
    `- ${proposal.summary || "NA"}`
  ].join("\n");
}

function displayOwner(owner) { return normalizePerson(owner) === "vivi" ? "Vivi" : "Zac"; }
function normalizePerson(value) { return String(value || "").toLowerCase().includes("vivi") ? "vivi" : "zac"; }
function stringArray(value) { return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : arrayValue(value); }
function normalizeDate(value) { const date = new Date(value || Date.now()); return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(); }

async function exists(filePath) { try { await fs.access(filePath); return true; } catch { return false; } }

async function archiveSource(intakePath, intake, sourcePath, root, prefix) {
  await fs.mkdir(root, { recursive: true, mode: 0o2775 });
  const destination = path.join(root, `${prefix}-${intake.ingest_id}-${path.basename(sourcePath)}`);
  await fs.rename(sourcePath, destination);
  intake.source_destination = relativePath(workspaceRoot, destination);
}

async function runHermes(prompt, model, maxTurns, toolsets = null) {
  return runHermesCommand({
    command: hermesCommand,
    prompt,
    cwd: workspaceRoot,
    env: { ...process.env, AGENTRELAY_TASK_ADAPTER: "project-hermes-draft-router", AGENTRELAY_AGENT_ID: "project-hermes" },
    maxTurns,
    timeoutMs: hermesTimeoutMs,
    toolsets,
    model,
    provider: modelProvider
  });
}

async function appendCardSourceRefs(cardId, refs) {
  const cardPath = path.join(cardsRoot, "cards", `card-${cardId}.md`);
  if (!(await exists(cardPath))) return;
  const text = await fs.readFile(cardPath, "utf8");
  if (text.includes("source_refs:")) return;
  await fs.writeFile(cardPath, text.replace(/\n---\n/, `\nsource_refs:\n${refs.map((ref) => `  - ${ref}`).join("\n")}\n---\n`), { mode: 0o664 });
}

async function writePersonalCardForEvent(event, author, sourceRef, proposal, now) {
  const cardId = randomId("", 8);
  await writeCardAndContent(cardId, { event_id: event.human_event_id, human_event_id: event.human_event_id, author, occurred_at: proposal.occurred_at || event.occurred_at, submitted_at: now, title: proposal.title || event.title, participants: proposal.participants || event.participants, source_refs: [sourceRef], body: proposal.body || renderProposalBody(proposal) });
  return cardId;
}

async function audit(event, detail) { await appendJsonLine(logPath, { at: new Date().toISOString(), event, ...detail }); }
