#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  appendJsonLine,
  arrayValue,
  cardContentHash,
  extractDate,
  extractSectionItems,
  extractTitle,
  getWorkspaceRoot,
  isTextFile,
  normalizeSlug,
  normalizeSummaryPoints,
  parseFrontmatter,
  randomId,
  readJson,
  relativePath,
  fallbackSummaryPoints,
  unique,
  walkFiles,
  writeJsonAtomic
} from "./card-v1-lib.mjs";
import { createProjectTask } from "./task-registry.mjs";
import { loadProjectRoles, projectManager } from "./project-roles.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = getWorkspaceRoot(scriptDirectory);
const manager = projectManager(await loadProjectRoles(workspaceRoot));
const cardsRoot = path.join(workspaceRoot, "08-cards");
const inboxes = [
  { owner: "zac", path: path.join(cardsRoot, "inbox", "zac-draft") },
  { owner: "vivi", path: path.join(cardsRoot, "inbox", "vivi-draft") }
];
const processingRoot = path.join(cardsRoot, "processing");
const reviewRoot = path.join(cardsRoot, "review");
const eventsRoot = path.join(cardsRoot, "events");
const humanEventsRoot = path.join(cardsRoot, "human-events", "records");
const legacyRoot = path.join(cardsRoot, "legacy");
const quarantineRoot = path.join(cardsRoot, "quarantine");
const ingestionLog = path.join(cardsRoot, "ingestion_log.jsonl");
const hermesCommand = process.env.PROJECT_HERMES_COMMAND || "hermes";
const hermesMaxTurns = Number(process.env.PROJECT_HERMES_CARD_MAX_TURNS || 4);
const hermesTimeoutMs = Number(process.env.PROJECT_HERMES_CARD_TIMEOUT_MS || 600000);
const maxSourceChars = Number(process.env.PROJECT_HERMES_CARD_MAX_SOURCE_CHARS || 60000);
const renderOnly = process.argv.includes("--render-only");
const boundOnly = process.argv.includes("--bound-only");

await ensureDirectories();
let processed = 0;
let reviewed = 0;
let ignored = 0;
let failed = 0;

if (!renderOnly) {
  await recoverOrphanedReviews();
  await processResolvedReviews();
  await claimInboxFiles();
  await processPendingIntakes();
}

await import(pathToFileURL(path.join(scriptDirectory, "render-card-index.mjs")).href + "?run=" + Date.now());
if (failed === 0) await publishWorkspace("hermes-card-ingest-completed");
console.log(JSON.stringify({ ok: failed === 0, processed, reviewed, ignored, failed, workspace: workspaceRoot }, null, 2));
if (failed > 0) process.exitCode = 1;

async function ensureDirectories() {
  const dirs = [
    ...inboxes.map((item) => item.path),
    processingRoot,
    path.join(reviewRoot, "zac"),
    path.join(reviewRoot, "vivi"),
    eventsRoot,
    path.join(cardsRoot, "cards"),
    path.join(cardsRoot, "contents"),
    quarantineRoot,
    path.join(legacyRoot, "ignored")
  ];
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true, mode: 0o2775 });
    await fs.chmod(dir, 0o2775).catch(() => {});
  }
}

async function publishWorkspace(reason) {
  await new Promise((resolveRun) => {
    const child = spawn(process.execPath, [path.join(scriptDirectory, "publish-workspace.mjs"), "--reason", reason], {
      cwd: workspaceRoot,
      env: { ...process.env, COLLAB_WORKSPACE: workspaceRoot },
      stdio: ["ignore", "inherit", "inherit"]
    });
    child.on("error", (error) => {
      console.error("workspace publication failed", error.message || error);
      resolveRun();
    });
    child.on("close", () => resolveRun());
  });
}

async function claimInboxFiles() {
  for (const inbox of inboxes) {
    const files = await walkFiles(inbox.path, () => true);
    for (const filePath of files) {
      if (boundOnly) {
        const parsed = parseFrontmatter(await fs.readFile(filePath, "utf8"));
        const humanEventId = String(parsed.data.human_event_id || "").trim();
        if (!humanEventId || !(await exists(path.join(humanEventsRoot, humanEventId, "event.json")))) continue;
      }
      const ingestId = randomId("ing-", 8);
      const intakeDir = path.join(processingRoot, ingestId);
      await fs.mkdir(intakeDir, { recursive: true, mode: 0o2775 });
      const sourcePath = path.join(intakeDir, path.basename(filePath));
      const stats = await fs.stat(filePath);
      await fs.rename(filePath, sourcePath);
      const intake = {
        schema_version: 1,
        ingest_id: ingestId,
        owner: inbox.owner,
        original_filename: path.basename(filePath),
        human_event_id: String(parseFrontmatter(await fs.readFile(sourcePath, "utf8")).data.human_event_id || ""),
        source_path: relativePath(workspaceRoot, sourcePath),
        submitted_at: stats.mtime.toISOString(),
        status: "claimed",
        attempts: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      await writeJsonAtomic(path.join(intakeDir, "intake.json"), intake);
      await audit("intake.claimed", { ingest_id: ingestId, owner: inbox.owner, original_filename: intake.original_filename });
    }
  }
}

async function processPendingIntakes() {
  const intakeFiles = await walkFiles(processingRoot, (filePath) => path.basename(filePath) === "intake.json");
  for (const intakePath of intakeFiles) {
    let intake = await readJson(intakePath);
    if (boundOnly && !String(intake.human_event_id || intake.proposal?.human_event_id || "").trim()) continue;
    if (intake.status === "archived" || intake.status === "review" || intake.status === "ignored") continue;
    try {
      const archivedCard = await findArchivedCardByIngestId(intake.ingest_id);
      if (archivedCard) {
        await recoverArchivedIntake(intakePath, intake, archivedCard);
        processed += 1;
        continue;
      }
      const intakeDir = path.dirname(intakePath);
      let sourcePath = await locateSource(intakeDir, intake.original_filename);
      if (!sourcePath && intake.source_destination) {
        const archivedSource = path.join(workspaceRoot, intake.source_destination);
        if (await exists(archivedSource)) sourcePath = archivedSource;
      }
      if (!sourcePath) throw new Error("processing source is missing");
      if (intake.status === "approved" && (intake.human_event_direct === true || intake.topic_direct === true)) {
        await commitHumanEventIntake(intakePath, intake, sourcePath);
        processed += 1;
        continue;
      }
      if (intake.status !== "approved") {
        intake.attempts = Number(intake.attempts || 0) + 1;
        intake.updated_at = new Date().toISOString();
        await writeJsonAtomic(intakePath, intake);
        if (!isTextFile(sourcePath)) {
          await moveToReview(intakePath, intake, sourcePath, {
            decision: "review",
            confidence: "low",
            uncertainty_reason: "Unsupported source type; Hermes currently reads text, Markdown, JSON and HTML.",
            candidate_event_ids: []
          });
          reviewed += 1;
          continue;
        }
        const sourceText = await fs.readFile(sourcePath, "utf8");
        if (!sourceText.trim()) {
          await moveToReview(intakePath, intake, sourcePath, {
            decision: "review",
            confidence: "high",
            uncertainty_reason: "The submitted source file is empty (0 bytes); there is no content to classify. Confirm ignore, or ask the submitter to resubmit with content.",
            candidate_event_ids: [],
            review_kind: "event_ownership",
            title: `${intake.original_filename}（空提交）`
          });
          reviewed += 1;
          continue;
        }
        const humanEventCard = await classifyHumanEventCard(intake, sourcePath, sourceText);
        if (humanEventCard?.decision === "review") {
          await moveToReview(intakePath, intake, sourcePath, humanEventCard);
          reviewed += 1;
          continue;
        }
        if (humanEventCard?.decision === "human_event" || humanEventCard?.decision === "topic") {
          intake.status = "approved";
          intake.human_event_direct = humanEventCard.decision === "human_event";
          intake.topic_direct = humanEventCard.decision === "topic";
          intake.proposal = humanEventCard;
          intake.event_id = humanEventCard.human_event_id;
          intake.card_id = randomId("", 8);
          intake.updated_at = new Date().toISOString();
          await writeJsonAtomic(intakePath, intake);
          await commitHumanEventIntake(intakePath, intake, sourcePath);
          processed += 1;
          continue;
        }
        const proposal = normalizeProposal(await askHermes(intake, sourceText));
        const validation = await validateProposal(proposal);
        if (!validation.ok || proposal.decision === "review" || proposal.confidence === "low") {
          await moveToReview(intakePath, intake, sourcePath, {
            ...proposal,
            uncertainty_reason: proposal.uncertainty_reason || validation.reason
          });
          reviewed += 1;
          continue;
        }
        if (proposal.decision === "ignore") {
          await ignoreIntake(intakePath, intake, sourcePath, proposal);
          ignored += 1;
          continue;
        }
        intake.status = "approved";
        intake.proposal = proposal;
        intake.event_id = proposal.decision === "link" ? proposal.event_id : randomId("evt-", 6);
        intake.card_id = randomId("", 8);
        intake.updated_at = new Date().toISOString();
        await writeJsonAtomic(intakePath, intake);
      }
      await commitApprovedIntake(intakePath, intake, sourcePath);
      processed += 1;
    } catch (error) {
      failed += 1;
      const intake = await readJson(intakePath, {});
      intake.status = intake.status === "approved" ? "approved" : "retry";
      intake.last_error = String(error.message || error);
      intake.updated_at = new Date().toISOString();
      await writeJsonAtomic(intakePath, intake);
      await audit("intake.failed", { ingest_id: intake.ingest_id, error: intake.last_error });
      console.error("ingest failed " + (intake.ingest_id || intakePath) + ": " + intake.last_error);
    }
  }
}

async function findArchivedCardByIngestId(ingestId) {
  if (!ingestId) return null;
  const cardFiles = await walkFiles(
    eventsRoot,
    (filePath) => isTextFile(filePath) && path.basename(path.dirname(filePath)) === "cards"
  );
  for (const cardPath of cardFiles) {
    const parsed = parseFrontmatter(await fs.readFile(cardPath, "utf8"));
    if (String(parsed.data.ingest_id || "") !== String(ingestId)) continue;
    return {
      card_id: String(parsed.data.card_id || ""),
      event_id: String(parsed.data.event_id || ""),
      card_path: relativePath(workspaceRoot, cardPath),
      source_destination: String(parsed.data.source_ref || "")
    };
  }
  return null;
}

async function recoverArchivedIntake(intakePath, intake, archivedCard) {
  const now = new Date().toISOString();
  intake.status = "archived";
  intake.card_id = archivedCard.card_id;
  intake.event_id = archivedCard.event_id;
  intake.card_path = archivedCard.card_path;
  intake.source_destination = archivedCard.source_destination;
  intake.archived_at = now;
  intake.updated_at = now;
  delete intake.last_error;
  await writeJsonAtomic(intakePath, intake);
  await audit("intake.recovered", {
    ingest_id: intake.ingest_id,
    event_id: intake.event_id,
    card_id: intake.card_id,
    card_path: intake.card_path,
    source_path: intake.source_destination
  });
}

async function classifyHumanEventCard(intake, sourcePath, sourceText) {
  const parsed = parseFrontmatter(sourceText);
  const humanEventId = String(parsed.data.human_event_id || "").trim();
  const topicId = String(parsed.data.topic_id || "").trim();
  if (!humanEventId && !topicId) return null;

  const eventPath = humanEventId ? path.join(humanEventsRoot, humanEventId, "event.json") : "";
  const event = humanEventId ? await readJson(eventPath, null) : null;
  const topic = topicId ? await findTopicManifest(topicId) : null;
  const explicitAuthor = normalizePerson(parsed.data.author || "");
  const owner = normalizePerson(intake.owner);
  const cardType = String(parsed.data.card_type || "personal").toLowerCase();
  let uncertaintyReason = "";
  if (humanEventId && !event) uncertaintyReason = `Human Event ${humanEventId} does not exist.`;
  else if (!humanEventId && topicId && !topic) uncertaintyReason = `Topic ${topicId} does not exist.`;
  else if (explicitAuthor && explicitAuthor !== owner) {
    uncertaintyReason = `Card author ${parsed.data.author} conflicts with inbox owner ${intake.owner}.`;
  } else if (cardType !== "personal") {
    uncertaintyReason = `Human Event submissions must be personal cards, got ${cardType}.`;
  }
  if (uncertaintyReason) {
    return {
      decision: "review",
      confidence: "low",
      human_event_id: humanEventId,
      topic_id: topicId,
      title: extractTitle(parsed, intake.original_filename),
      event_title: event?.title || topic?.title || "",
      candidate_event_ids: [],
      uncertainty_reason: uncertaintyReason,
      review_kind: "human_event_card_validation"
    };
  }

  const stats = await fs.stat(sourcePath);
  const occurredAt = extractDate(parsed, intake.original_filename, stats).toISOString();
  const body = parsed.body.trim();
  const title = extractTitle(parsed, intake.original_filename);
  const summary = await summarizeArtifact(intake, title, body);
  const placementType = ["human_event", "topic"].includes(String(parsed.data.placement_type || "").trim().toLowerCase())
    ? String(parsed.data.placement_type).trim().toLowerCase()
    : (humanEventId ? "human_event" : "topic");
  return {
    decision: humanEventId ? "human_event" : "topic",
    confidence: "high",
    human_event_id: humanEventId,
    topic_id: topicId,
    placement_type: placementType,
    placement_id: placementType === "topic" ? topicId : humanEventId,
    source_refs: arrayValue(parsed.data.source_refs || parsed.data.source_ref),
    event_title: event?.title || topic?.title || "",
    topic_title: topic?.title || "",
    card_type: "personal",
    occurred_at: occurredAt,
    title,
    summary: summary.summary,
    summary_method: summary.method,
    participants: arrayValue(parsed.data.participants || parsed.data.people || [displayOwner(intake.owner)]),
    key_points: summary.key_points,
    perspectives: extractSectionItems(body, ["视角", "perspectives", "个人判断"]),
    conclusions: extractSectionItems(body, ["讨论结论", "当前结论", "共识", "结论"]),
    next_steps: extractSectionItems(body, ["下一步", "next", "next steps", "next_step"]),
    body
  };
}

async function commitHumanEventIntake(intakePath, intake, sourcePath) {
  const proposal = intake.proposal || {};
  const humanEventId = String(proposal.human_event_id || intake.event_id || "");
  const topicId = String(proposal.topic_id || "");
  const eventDir = humanEventId ? path.join(humanEventsRoot, humanEventId) : null;
  const topicDir = topicId ? path.join(cardsRoot, "topics", topicId) : null;
  const eventPath = eventDir ? path.join(eventDir, "event.json") : null;
  const reviewPath = eventDir ? path.join(eventDir, "review.json") : null;
  const event = eventPath ? await readJson(eventPath, null) : null;
  const topic = topicDir ? await readJson(path.join(topicDir, "topic.json"), null) : null;
  if (!event && !topic) throw new Error(humanEventId
    ? `Human Event ${humanEventId} does not exist`
    : `Topic ${topicId} does not exist`);

  const owner = normalizePerson(intake.owner);
  const ownerDisplay = displayOwner(owner);
  const relationshipDir = eventDir || topicDir;
  const submissionDir = path.join(relationshipDir, "sources", "card-submissions", owner);
  const sourceText = await fs.readFile(sourcePath, "utf8");
  const parsedSource = parseFrontmatter(sourceText);
  const contentHash = cardContentHash(parsedSource.data, parsedSource.body);
  const scopeId = humanEventId || topicId;
  const existingCards = await findBoundCardRecords(scopeId, owner);
  const duplicateCard = existingCards.find((card) => card.content_hash === contentHash);
  if (duplicateCard) {
    return quarantineHumanEventIntake(intakePath, intake, sourcePath, proposal, {
      ...duplicateCard,
      content_hash: contentHash
    });
  }
  const previousCard = existingCards
    .filter((card) => card.lifecycle_status === "accepted")
    .sort((left, right) => String(right.submitted_at).localeCompare(String(left.submitted_at)))[0] || null;
  const revisionNumber = existingCards.length + 1;
  const revisionGroupId = `${proposal.placement_type || (humanEventId ? "human_event" : "topic")}:${scopeId}:author:${owner}`;
  const sourceDestination = intake.source_destination
    ? path.join(workspaceRoot, intake.source_destination)
    : path.join(submissionDir, `${intake.ingest_id}-${path.basename(sourcePath)}`);
  const cardPath = path.join(cardsRoot, "cards", `card-${intake.card_id}.md`);
  const contentPath = path.join(cardsRoot, "contents", `content-${intake.card_id}.md`);
  const sourceRelative = relativePath(workspaceRoot, sourceDestination);
  const now = new Date().toISOString();

  intake.content_hash = contentHash;
  intake.lifecycle_status = "accepted";
  intake.revision_group_id = revisionGroupId;
  intake.revision_number = revisionNumber;
  if (previousCard) intake.supersedes_card_id = previousCard.card_id;
  intake.source_destination = sourceRelative;
  intake.card_path = relativePath(workspaceRoot, cardPath);
  intake.content_path = relativePath(workspaceRoot, contentPath);
  intake.updated_at = now;
  await writeJsonAtomic(intakePath, intake);
  await fs.mkdir(submissionDir, { recursive: true, mode: 0o2775 });
  if (!(await exists(sourceDestination))) await fs.rename(sourcePath, sourceDestination);
  await fs.chmod(sourceDestination, 0o664).catch(() => {});

  if (!(await exists(cardPath))) {
    const cardSourceRefs = unique([sourceRelative, ...(proposal.source_refs || [])]);
    await fs.writeFile(cardPath, renderHumanEventCardMarkdown({
      intake,
      proposal,
      event,
      topic,
      sourceRefs: cardSourceRefs,
      lifecycleStatus: "accepted",
      contentHash,
      revisionGroupId,
      revisionNumber,
      supersedesCardId: previousCard?.card_id || ""
    }), { mode: 0o664 });
  }
  if (!(await exists(contentPath))) {
    await fs.copyFile(sourceDestination, contentPath);
    await fs.chmod(contentPath, 0o664).catch(() => {});
  }

  if (previousCard) await markCardSuperseded(previousCard, intake.card_id, now);

  if (event) {
    const review = await readJson(reviewPath, null);
    if (review && !["pending_cards", "materializing"].includes(review.status)) {
      event.summary_revisions = [
        ...(event.summary_revisions || []),
        {
          summary: event.summary || "",
          key_points: event.key_points || [],
          summary_status: event.summary_status || "",
          replaced_at: now,
          reason: "late_personal_card"
        }
      ];
      event.summary_status = "provisional";
      event.status = "pending_human_review";
      review.status = "pending_cards";
      review.previous_resolution = review.resolution || review.consensus || null;
      review.resolution = null;
      review.consensus = null;
      review.review_resolution = null;
      review.correction_trigger_card_id = intake.card_id;
    }
    event.personal_card_ids = unique([
      ...(event.personal_card_ids || []).filter((cardId) => cardId !== previousCard?.card_id),
      intake.card_id
    ]);
    event.card_revision_ids_by_author = {
      ...(event.card_revision_ids_by_author || {}),
      [owner]: unique([...(event.card_revision_ids_by_author?.[owner] || []), ...(previousCard ? [previousCard.card_id] : [])])
    };
    event.updated_at = now;
    await writeJsonAtomic(eventPath, event);
    if (review) {
      review.card_ids_by_author = { ...(review.card_ids_by_author || {}), [owner]: intake.card_id };
      review.human_card_ids = unique([
        ...(review.human_card_ids || []).filter((cardId) => cardId !== previousCard?.card_id),
        intake.card_id
      ]);
      review.card_revision_ids_by_author = {
        ...(review.card_revision_ids_by_author || {}),
        [owner]: unique([...(review.card_revision_ids_by_author?.[owner] || []), ...(previousCard ? [previousCard.card_id] : [])])
      };
      review.updated_at = now;
      await writeJsonAtomic(reviewPath, review);
    }
  }
  if (topic) {
    topic.personal_card_ids = unique([
      ...(topic.personal_card_ids || []).filter((cardId) => cardId !== previousCard?.card_id),
      intake.card_id
    ]);
    topic.card_revision_ids_by_author = {
      ...(topic.card_revision_ids_by_author || {}),
      [owner]: unique([...(topic.card_revision_ids_by_author?.[owner] || []), ...(previousCard ? [previousCard.card_id] : [])])
    };
    topic.source_refs = unique([...(topic.source_refs || []), sourceRelative]);
    topic.updated_at = now;
    await writeJsonAtomic(path.join(topicDir, "topic.json"), topic);
  }

  intake.status = "archived";
  intake.archived_at = now;
  intake.updated_at = now;
  await writeJsonAtomic(intakePath, intake);
  await audit("intake.human_event_card_archived", {
    ingest_id: intake.ingest_id,
    owner,
    human_event_id: humanEventId || null,
    topic_id: topicId || null,
    card_id: intake.card_id,
    card_path: intake.card_path,
    content_path: intake.content_path
  });
}

async function findBoundCardRecords(scopeId, owner) {
  if (!scopeId || !owner) return [];
  const files = await walkFiles(cardsRoot, (filePath) => path.basename(filePath).startsWith("card-") && isTextFile(filePath));
  const records = [];
  for (const filePath of files) {
    const parsed = parseFrontmatter(await fs.readFile(filePath, "utf8"));
    const cardScope = String(parsed.data.human_event_id || parsed.data.topic_id || parsed.data.placement_id || "").trim();
    if (cardScope !== scopeId || normalizePerson(parsed.data.author || "") !== owner) continue;
    const lifecycleStatus = String(parsed.data.lifecycle_status || "accepted").toLowerCase();
    const contentHash = String(parsed.data.content_hash || "").trim() || await inferCardContentHash(parsed, filePath);
    const stats = await fs.stat(filePath);
    records.push({
      card_id: String(parsed.data.card_id || path.basename(filePath).replace(/^card-/, "").replace(/\.md$/, "")),
      lifecycle_status: lifecycleStatus,
      content_hash: contentHash,
      submitted_at: String(parsed.data.submitted_at || stats.mtime.toISOString()),
      path: filePath,
      relative_path: relativePath(workspaceRoot, filePath),
      in_quarantine: filePath.includes(`${path.sep}quarantine${path.sep}`)
    });
  }
  return records;
}

async function inferCardContentHash(parsed, cardPath) {
  const sourceRefs = arrayValue(parsed.data.source_refs || parsed.data.source_ref);
  for (const sourceRef of sourceRefs) {
    if (!sourceRef || /^https?:\/\//i.test(sourceRef)) continue;
    const sourcePath = path.resolve(workspaceRoot, sourceRef);
    if (!(await exists(sourcePath))) continue;
    const source = parseFrontmatter(await fs.readFile(sourcePath, "utf8"));
    return cardContentHash(source.data, source.body);
  }
  return cardContentHash(parsed.data, parsed.body);
}

async function markCardSuperseded(card, replacementCardId, now) {
  if (!card?.path || card.lifecycle_status === "superseded") return;
  const raw = await fs.readFile(card.path, "utf8");
  const parsed = parseFrontmatter(raw);
  let updated = raw.replace(/^lifecycle_status:.*$/m, "lifecycle_status: superseded");
  if (!/^lifecycle_status:/m.test(raw)) updated = updated.replace(/^---\n/, "---\nlifecycle_status: superseded\n");
  updated = upsertFrontmatterField(updated, "superseded_by_card_id", replacementCardId);
  updated = upsertFrontmatterField(updated, "superseded_at", now);
  await fs.writeFile(card.path, updated, { mode: 0o664 });
  await fs.chmod(card.path, 0o664).catch(() => {});
}

function upsertFrontmatterField(raw, key, value) {
  const line = `${key}: ${value}`;
  const pattern = new RegExp(`^${key}:.*$`, "m");
  return pattern.test(raw) ? raw.replace(pattern, line) : raw.replace(/^---\n/, `---\n${line}\n`);
}

async function quarantineHumanEventIntake(intakePath, intake, sourcePath, proposal, duplicateCard) {
  const now = new Date().toISOString();
  const owner = normalizePerson(intake.owner);
  const eventId = String(proposal.human_event_id || intake.event_id || "unbound");
  const destinationDir = path.join(quarantineRoot, `${compactDate(intake.submitted_at)}-${owner}-duplicate-ingest`, intake.ingest_id);
  await fs.mkdir(destinationDir, { recursive: true, mode: 0o2775 });
  const sourceDestination = path.join(destinationDir, `${intake.ingest_id}-${path.basename(sourcePath)}`);
  if (!(await exists(sourceDestination))) await fs.rename(sourcePath, sourceDestination);
  const sourceRelative = relativePath(workspaceRoot, sourceDestination);
  const cardPath = path.join(destinationDir, `card-${intake.card_id}.md`);
  const contentPath = path.join(destinationDir, `content-${intake.card_id}.md`);
  const contentHash = duplicateCard.content_hash;
  await fs.writeFile(cardPath, renderHumanEventCardMarkdown({
    intake,
    proposal,
    event: null,
    topic: null,
    sourceRefs: unique([sourceRelative, ...(proposal.source_refs || [])]),
    lifecycleStatus: "quarantined",
    contentHash,
    duplicateOfCardId: duplicateCard.card_id
  }), { mode: 0o664 });
  await fs.copyFile(sourceDestination, contentPath);
  intake.status = "archived";
  intake.archived_at = now;
  intake.updated_at = now;
  intake.lifecycle_status = "quarantined";
  intake.content_hash = contentHash;
  intake.duplicate_of_card_id = duplicateCard.card_id;
  intake.quarantine_reason = "duplicate content within the same Human Event/Topic and author";
  intake.source_destination = sourceRelative;
  intake.card_path = relativePath(workspaceRoot, cardPath);
  intake.content_path = relativePath(workspaceRoot, contentPath);
  await writeJsonAtomic(intakePath, intake);
  await audit("intake.duplicate_quarantined", {
    ingest_id: intake.ingest_id,
    owner,
    human_event_id: eventId,
    card_id: intake.card_id,
    duplicate_of_card_id: duplicateCard.card_id,
    content_hash: contentHash,
    source_path: sourceRelative
  });
}

function renderHumanEventCardMarkdown({ intake, proposal, event, topic, sourceRefs, lifecycleStatus, contentHash, revisionGroupId = "", revisionNumber = "", supersedesCardId = "", duplicateOfCardId = "" }) {
  const title = proposal.title || event?.title || topic?.title || "Personal Card";
  const summaryPoints = normalizeSummaryPoints(proposal.key_points).length
    ? normalizeSummaryPoints(proposal.key_points)
    : fallbackSummaryPoints(proposal.body || "", title, 3);
  const lines = [
    "---",
    `card_id: ${intake.card_id}`,
    `content_id: ${intake.card_id}`,
    ...(proposal.human_event_id ? [`event_id: ${proposal.human_event_id}`, `human_event_id: ${proposal.human_event_id}`] : []),
    ...(proposal.topic_id ? [`topic_id: ${proposal.topic_id}`] : []),
    `placement_type: ${proposal.placement_type || (proposal.human_event_id ? "human_event" : "topic")}`,
    `placement_id: ${proposal.placement_id || (proposal.human_event_id || proposal.topic_id || "")}`,
    "card_type: personal",
    `author: ${displayOwner(intake.owner)}`,
    `occurred_at: ${proposal.occurred_at || intake.submitted_at}`,
    `submitted_at: ${intake.submitted_at}`,
    `lifecycle_status: ${lifecycleStatus}`,
    `content_hash: ${contentHash}`,
    ...(revisionGroupId ? [`revision_group_id: ${revisionGroupId}`, `revision_number: ${revisionNumber}`] : []),
    ...(supersedesCardId ? [`supersedes_card_id: ${supersedesCardId}`] : []),
    ...(duplicateOfCardId ? [`duplicate_of_card_id: ${duplicateOfCardId}`] : []),
    `summary: ${JSON.stringify(proposal.summary || summaryPoints[0] || "")}`,
    `summary_method: ${proposal.summary_method || "deterministic-fallback"}`,
    `title: ${JSON.stringify(title)}`,
    "participants:",
    ...(proposal.participants || []).map((person) => `  - ${person}`),
    "source_refs:",
    ...sourceRefs.map((sourceRef) => `  - ${sourceRef}`),
    `ingest_id: ${intake.ingest_id}`,
    "---",
    "",
    `# ${title}`,
    "",
    "## 卡片要点",
    ...summaryPoints.map((item) => `- ${item}`),
    "",
    "## 原始 Artifact",
    String(proposal.body || `# ${title}`).trim(),
    ""
  ];
  return lines.join("\n");
}

async function processResolvedReviews() {
  const reviewFiles = await walkFiles(reviewRoot, (filePath) => path.basename(filePath) === "review.json");
  for (const reviewPath of reviewFiles) {
    const review = await readJson(reviewPath);
    if (review.review_kind === "draft_routing") continue;
    if (review.status !== "resolved") continue;
    const decision = String(review.decision || "").toLowerCase();
    if (!["link", "create", "ignore"].includes(decision)) continue;
    const reviewDir = path.dirname(reviewPath);
    const sourcePath = await locateSource(reviewDir, review.original_filename);
    if (!sourcePath) {
      review.status = "error";
      review.last_error = "review source is missing";
      await writeJsonAtomic(reviewPath, review);
      continue;
    }
    if (decision === "ignore") {
      await archiveIgnoredReview(reviewPath, review, sourcePath);
      ignored += 1;
      continue;
    }
    const proposal = normalizeProposal({
      ...(review.proposal || {}),
      decision,
      event_id: review.selected_event_id || review.event_id || review.proposal?.event_id,
      event_title: review.new_event_title || review.proposal?.event_title,
      confidence: "high"
    });
    const validation = await validateProposal(proposal);
    if (!validation.ok) {
      review.status = "error";
      review.last_error = validation.reason;
      await writeJsonAtomic(reviewPath, review);
      continue;
    }
    const intakeDir = path.join(processingRoot, review.ingest_id);
    await fs.mkdir(intakeDir, { recursive: true, mode: 0o2775 });
    const processingSource = path.join(intakeDir, path.basename(sourcePath));
    await fs.rename(sourcePath, processingSource);
    const intake = {
      schema_version: 1,
      ingest_id: review.ingest_id,
      owner: review.submitted_by || review.owner,
      original_filename: review.original_filename,
      source_path: relativePath(workspaceRoot, processingSource),
      submitted_at: review.submitted_at,
      status: "approved",
      attempts: Number(review.attempts || 1),
      proposal,
      event_id: decision === "link" ? proposal.event_id : randomId("evt-", 6),
      card_id: randomId("", 8),
      review_path: relativePath(workspaceRoot, reviewPath),
      created_at: review.created_at,
      updated_at: new Date().toISOString()
    };
    await writeJsonAtomic(path.join(intakeDir, "intake.json"), intake);
    review.status = "processing";
    review.updated_at = new Date().toISOString();
    await writeJsonAtomic(reviewPath, review);
  }
}

async function askHermes(intake, sourceText) {
  if (process.env.PROJECT_HERMES_CARD_TEST_PROPOSAL_JSON) {
    return JSON.parse(process.env.PROJECT_HERMES_CARD_TEST_PROPOSAL_JSON);
  }
  const catalog = await eventCatalog();
  const prompt = [
    "You are Project Hermes, the Card v1 event archivist.",
    "Analyze one submitted workspace source. Do not edit any files.",
    "",
    "Decide whether this source materially changes project knowledge, decision, direction, progress, risk, or action.",
    "Use link only when it is clearly the same object, same stage, and same change as an existing event.",
    "Same topic with a new decision, result, or progress must be create.",
    "If uncertain, return review. Prefer review over an incorrect merge.",
    "",
    "Return exactly one JSON object:",
    "{",
    "  \"decision\": \"link|create|review|ignore\",",
    "  \"confidence\": \"high|medium|low\",",
    "  \"event_id\": \"existing id for link, otherwise empty\",",
    "  \"human_event_id\": \"copy explicit human_event_id from the source when present\",",
    "  \"topic_id\": \"copy explicit topic_id from the source when present\",",
    "  \"event_title\": \"concise event title\",",
    "  \"card_type\": \"collaboration|personal\",",
    "  \"occurred_at\": \"ISO date/time or YYYY-MM-DD\",",
    "  \"title\": \"one sentence: who did what\",",
    "  \"participants\": [\"name\"],",
    "  \"key_points\": [\"fact\"],",
    "  \"perspectives\": [\"named perspective\"],",
    "  \"conclusions\": [\"confirmed conclusion\"],",
    "  \"next_steps\": [\"next step\"],",
    "  \"candidate_event_ids\": [\"event id\"],",
    "  \"uncertainty_reason\": \"why review is needed\"",
    "}",
    "",
    "Submitter: " + intake.owner,
    "Submitted at: " + intake.submitted_at,
    "Original filename: " + intake.original_filename,
    "",
    "Existing events:",
    JSON.stringify(catalog, null, 2),
    "",
    "Source:",
    sourceText.slice(0, maxSourceChars)
  ].join("\n");
  const run = await runHermes(prompt);
  if (run.code !== 0) throw new Error("Hermes exited " + run.code + ": " + run.stderr.slice(-600));
  return parseJsonObject(run.stdout);
}

function runHermes(prompt) {
  return new Promise((resolveRun) => {
    const child = spawn(hermesCommand, [
      "chat",
      "--quiet",
      "--accept-hooks",
      "--max-turns",
      String(hermesMaxTurns),
      "--query",
      prompt
    ], {
      cwd: workspaceRoot,
      env: { ...process.env, AGENTRELAY_TASK_ADAPTER: "project-hermes-card-ingest", AGENTRELAY_AGENT_ID: "project-hermes" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      stderr += "\nHermes card ingest timed out.";
    }, hermesTimeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ code: 1, stdout, stderr: stderr + "\n" + error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? 1, stdout, stderr });
    });
  });
}

function parseJsonObject(stdout) {
  const text = String(stdout || "").trim();
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.unshift(fenced[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("Hermes did not return valid JSON");
}

async function summarizeArtifact(intake, title, body) {
  const fallback = fallbackSummaryPoints(body, title, 3);
  const disabled = ["0", "false", "no", "off"].includes(String(process.env.PROJECT_HERMES_CARD_SUMMARY_ENABLED || "1").toLowerCase());
  if (disabled) return { summary: fallback[0] || "", key_points: fallback, method: "deterministic-fallback" };

  const prompt = [
    "You are Hermes creating the human-readable summary for one Personal Card.",
    "Read the complete Artifact below and summarize only what it establishes.",
    "Prefer one concise sentence; return at most three concise bullet points when the Artifact contains independent conclusions.",
    "Do not invent facts, do not list file paths or every task, and do not repeat the title.",
    "Return exactly one JSON object: {\"summary\":\"one sentence\",\"key_points\":[\"point\"]}.",
    `Submitter: ${intake.owner}`,
    `Title: ${title}`,
    "Artifact:",
    String(body || "").slice(0, maxSourceChars)
  ].join("\n\n");
  try {
    const run = await runHermes(prompt);
    if (run.code !== 0) throw new Error(run.stderr || `Hermes exited ${run.code}`);
    const raw = parseJsonObject(run.stdout);
    const points = normalizeSummaryPoints(raw.key_points || raw.points || raw.summary, 3);
    if (!points.length) throw new Error("Hermes returned an empty card summary");
    const summary = normalizeSummaryPoints(raw.summary, 1)[0] || points[0];
    return { summary, key_points: points, method: "hermes" };
  } catch (error) {
    await audit("card.summary_fallback", {
      ingest_id: intake.ingest_id,
      reason: String(error.message || error).slice(0, 500)
    });
    return { summary: fallback[0] || "", key_points: fallback, method: "deterministic-fallback" };
  }
}

function normalizeProposal(raw) {
  const decision = String(raw?.decision || "review").toLowerCase();
  const confidence = String(raw?.confidence || "low").toLowerCase();
  return {
    decision: ["link", "create", "review", "ignore"].includes(decision) ? decision : "review",
    confidence: ["high", "medium", "low"].includes(confidence) ? confidence : "low",
    event_id: String(raw?.event_id || ""),
    human_event_id: String(raw?.human_event_id || ""),
    topic_id: String(raw?.topic_id || ""),
    event_title: String(raw?.event_title || "").trim(),
    card_type: raw?.card_type === "collaboration" ? "collaboration" : "personal",
    occurred_at: normalizeDate(raw?.occurred_at),
    title: String(raw?.title || raw?.event_title || "Untitled card").trim().slice(0, 160),
    summary: String(raw?.summary || "").trim(),
    participants: stringArray(raw?.participants),
    key_points: normalizeSummaryPoints(raw?.key_points),
    perspectives: stringArray(raw?.perspectives),
    conclusions: stringArray(raw?.conclusions),
    next_steps: stringArray(raw?.next_steps),
    candidate_event_ids: stringArray(raw?.candidate_event_ids),
    uncertainty_reason: String(raw?.uncertainty_reason || "").trim()
  };
}

async function validateProposal(proposal) {
  if (proposal.decision === "link") {
    if (!proposal.event_id) return { ok: false, reason: "Link decision has no event_id." };
    const manifest = await findEventManifest(proposal.event_id);
    if (!manifest) return { ok: false, reason: "Linked event_id does not exist." };
  }
  if (proposal.decision === "create" && !proposal.event_title) {
    return { ok: false, reason: "Create decision has no event title." };
  }
  return { ok: true, reason: "" };
}

async function commitApprovedIntake(intakePath, intake, sourcePath) {
  const proposal = normalizeProposal(intake.proposal);
  let eventRecord = await findEventManifest(intake.event_id);
  let eventDir;
  if (eventRecord) {
    eventDir = path.dirname(eventRecord._path);
  } else {
    const eventSlug = normalizeSlug(proposal.event_title, "event").slice(0, 64);
    eventDir = path.join(eventsRoot, intake.event_id + "-" + eventSlug);
  }
  const cardsDir = path.join(eventDir, "cards");
  const sourcesDir = path.join(eventDir, "sources");
  await fs.mkdir(cardsDir, { recursive: true, mode: 0o2775 });
  await fs.mkdir(sourcesDir, { recursive: true, mode: 0o2775 });

  const dateKey = compactDate(proposal.occurred_at || intake.submitted_at);
  const author = normalizeSlug(intake.owner, "unknown");
  const titleSlug = normalizeSlug(proposal.title, "card").slice(0, 48);
  const cardFilename = dateKey + "-" + proposal.card_type + "-" + author + "-" + titleSlug + "-" + intake.card_id.slice(-4) + ".md";
  const cardPath = path.join(cardsDir, cardFilename);
  const sourceDestination = intake.source_destination
    ? path.join(workspaceRoot, intake.source_destination)
    : path.join(sourcesDir, intake.ingest_id + "-" + path.basename(sourcePath));
  const sourceRelative = relativePath(workspaceRoot, sourceDestination);

  intake.source_destination = sourceRelative;
  intake.card_path = relativePath(workspaceRoot, cardPath);
  intake.updated_at = new Date().toISOString();
  await writeJsonAtomic(intakePath, intake);

  if (!(await exists(sourceDestination))) await fs.rename(sourcePath, sourceDestination);
  await fs.chmod(sourceDestination, 0o664).catch(() => {});
  if (!(await exists(cardPath))) {
    await fs.writeFile(cardPath, renderCardMarkdown(intake, proposal, sourceRelative), { mode: 0o664 });
    await fs.chmod(cardPath, 0o664).catch(() => {});
  }

  const now = new Date().toISOString();
  const eventPath = path.join(eventDir, "event.json");
  const existing = eventRecord?.manifest || await readJson(eventPath, {});
  const event = {
    event_id: intake.event_id,
    title: existing.title || proposal.event_title || proposal.title,
    status: existing.status || "active",
    first_occurred_at: earlierDate(existing.first_occurred_at, proposal.occurred_at || intake.submitted_at),
    latest_activity_at: laterDate(existing.latest_activity_at, proposal.occurred_at || intake.submitted_at),
    participants: unique([...(existing.participants || []), ...proposal.participants]),
    card_ids: unique([...(existing.card_ids || []), intake.card_id]),
    source_refs: unique([...(existing.source_refs || []), sourceRelative]),
    related_event_ids: existing.related_event_ids || [],
    merged_into: existing.merged_into || null,
    test: existing.test === true,
    created_at: existing.created_at || now,
    updated_at: now
  };
  await writeJsonAtomic(eventPath, event);
  intake.status = "archived";
  intake.archived_at = now;
  intake.updated_at = now;
  await writeJsonAtomic(intakePath, intake);
  if (intake.review_path) {
    const reviewPath = path.join(workspaceRoot, intake.review_path);
    const review = await readJson(reviewPath, {});
    review.status = "archived";
    review.event_id = intake.event_id;
    review.card_id = intake.card_id;
    review.archived_at = now;
    review.updated_at = now;
    await writeJsonAtomic(reviewPath, review);
  }
  await audit("intake.archived", {
    ingest_id: intake.ingest_id,
    owner: intake.owner,
    event_id: intake.event_id,
    card_id: intake.card_id,
    card_path: intake.card_path,
    source_path: intake.source_destination
  });
}

function renderCardMarkdown(intake, proposal, sourceRelative) {
  const keyPoints = normalizeSummaryPoints(proposal.key_points);
  const lines = [
    "---",
    "card_id: " + intake.card_id,
    "content_id: " + intake.card_id,
    "event_id: " + intake.event_id,
    ...(proposal.human_event_id ? ["human_event_id: " + proposal.human_event_id] : []),
    ...(proposal.topic_id ? ["topic_id: " + proposal.topic_id] : []),
    "placement_type: " + (proposal.topic_id ? "topic" : (proposal.human_event_id ? "human_event" : "event")),
    "placement_id: " + (proposal.topic_id || proposal.human_event_id || intake.event_id),
    "card_type: " + proposal.card_type,
    "author: " + intake.owner,
    "occurred_at: " + proposal.occurred_at,
    "submitted_at: " + intake.submitted_at,
    "summary: " + JSON.stringify(proposal.summary || keyPoints[0] || ""),
    "summary_method: indexed-proposal",
    "title: " + JSON.stringify(proposal.title),
    "participants:"
  ];
  for (const participant of proposal.participants) lines.push("  - " + participant);
  lines.push("source_ref: " + sourceRelative, "ingest_id: " + intake.ingest_id, "---", "", "# " + proposal.title, "");
  appendSection(lines, "卡片要点", keyPoints);
  appendSection(lines, "视角", proposal.perspectives);
  appendSection(lines, "讨论结论", proposal.conclusions);
  appendSection(lines, "下一步", proposal.next_steps);
  return lines.join("\n").trim() + "\n";
}

function appendSection(lines, title, items) {
  lines.push("## " + title, "");
  if (!items.length) lines.push("- NA");
  else for (const item of items) lines.push("- " + item);
  lines.push("");
}

async function moveToReview(intakePath, intake, sourcePath, proposal) {
  const reviewDir = path.join(reviewRoot, intake.owner, intake.ingest_id);
  await fs.mkdir(reviewDir, { recursive: true, mode: 0o2775 });
  const reviewSource = path.join(reviewDir, path.basename(sourcePath));
  if (!(await exists(reviewSource))) await fs.rename(sourcePath, reviewSource);
  await fs.chmod(reviewSource, 0o664).catch(() => {});
  const review = {
    schema_version: 1,
    review_kind: proposal.review_kind || "event_ownership",
    submitted_by: intake.owner,
    owner: manager.person,
    owner_agent_id: manager.agent_id,
    manager,
    ingest_id: intake.ingest_id,
    original_filename: intake.original_filename,
    submitted_at: intake.submitted_at,
    summary: proposal.title || "Hermes could not confidently classify this source.",
    candidate_events: proposal.candidate_event_ids || [],
    hermes_recommendation: proposal.decision || "review",
    uncertainty_reason: proposal.uncertainty_reason || "Event ownership is uncertain.",
    question: proposal.review_kind === "human_event_card_validation"
      ? "Correct the card author, card_type, or human_event_id and resubmit the Personal Card."
      : "Choose link, create, or ignore for this source.",
    status: "need_review",
    relay_task_id: null,
    decision: null,
    selected_event_id: null,
    new_event_title: null,
    proposal,
    attempts: intake.attempts,
    created_at: intake.created_at,
    updated_at: new Date().toISOString()
  };
  const reviewPath = path.join(reviewDir, "review.json");
  await writeJsonAtomic(reviewPath, review);
  review.task_id = await createCardValidationReviewTask(review, reviewPath);
  await writeJsonAtomic(reviewPath, review);
  intake.status = "review";
  intake.review_path = relativePath(workspaceRoot, path.join(reviewDir, "review.json"));
  intake.updated_at = new Date().toISOString();
  await writeJsonAtomic(intakePath, intake);
  await audit("intake.review", { ingest_id: intake.ingest_id, owner: intake.owner, review_path: intake.review_path, task_id: review.task_id });
}

async function createCardValidationReviewTask(review, reviewPath) {
  const taskResult = await createProjectTask(workspaceRoot, {
    task_kind: "card_validation_review",
    task_role: "manager_review",
    manager_role: manager.role,
    review_status: "need_review",
    title: `Review Card：${review.original_filename}`,
    content: `${review.question}\n\nReview 文件：${relativePath(workspaceRoot, reviewPath)}`,
    owner: manager.person,
    target_agent_id: manager.agent_id,
    origin_ref: `card-review:${review.ingest_id}`,
    done_criteria: `已更新 ${relativePath(workspaceRoot, reviewPath)}，status=resolved，并完成该 Card 的归属或校验决定。`,
    human_event_ids: review.human_event_id ? [review.human_event_id] : [],
    source_refs: [relativePath(workspaceRoot, reviewPath)],
    priority: "high",
    risk_level: "L1"
  }, { enqueue: true });
  return taskResult.task.task_id;
}

async function recoverOrphanedReviews() {
  const reviewFiles = await walkFiles(reviewRoot, (filePath) => path.basename(filePath) === "review.json");
  for (const reviewPath of reviewFiles) {
    const review = await readJson(reviewPath, null);
    if (!review || review.review_kind === "draft_routing") continue;
    if (!["pending_dispatch", "need_review"].includes(review.status)) continue;
    if (review.task_id || review.relay_task_id) continue;
    review.status = "need_review";
    review.updated_at = new Date().toISOString();
    review.task_id = await createCardValidationReviewTask(review, reviewPath);
    await writeJsonAtomic(reviewPath, review);
    await audit("intake.review_task_recovered", {
      ingest_id: review.ingest_id,
      review_path: relativePath(workspaceRoot, reviewPath),
      task_id: review.task_id
    });
  }
}

async function ignoreIntake(intakePath, intake, sourcePath, proposal) {
  const destination = path.join(legacyRoot, "ignored", intake.ingest_id + "-" + path.basename(sourcePath));
  if (!(await exists(destination))) await fs.rename(sourcePath, destination);
  await fs.chmod(destination, 0o664).catch(() => {});
  intake.status = "ignored";
  intake.ignore_reason = proposal.uncertainty_reason || "Hermes classified the source as non-material.";
  intake.source_destination = relativePath(workspaceRoot, destination);
  intake.updated_at = new Date().toISOString();
  await writeJsonAtomic(intakePath, intake);
  await audit("intake.ignored", { ingest_id: intake.ingest_id, owner: intake.owner, reason: intake.ignore_reason });
}

async function archiveIgnoredReview(reviewPath, review, sourcePath) {
  const destination = path.join(legacyRoot, "ignored", review.ingest_id + "-" + path.basename(sourcePath));
  if (!(await exists(destination))) await fs.rename(sourcePath, destination);
  await fs.chmod(destination, 0o664).catch(() => {});
  review.status = "ignored";
  review.source_destination = relativePath(workspaceRoot, destination);
  review.updated_at = new Date().toISOString();
  await writeJsonAtomic(reviewPath, review);
  await audit("review.ignored", { ingest_id: review.ingest_id, owner: review.owner });
}

async function eventCatalog() {
  const manifests = await loadEventRecords();
  return manifests
    .filter((record) => record.manifest.test !== true && !record.manifest.merged_into)
    .map((record) => ({
      event_id: record.manifest.event_id,
      title: record.manifest.title,
      status: record.manifest.status,
      latest_activity_at: record.manifest.latest_activity_at,
      participants: record.manifest.participants || []
    }));
}

async function loadEventRecords() {
  const files = await walkFiles(eventsRoot, (filePath) => path.basename(filePath) === "event.json");
  const records = [];
  for (const filePath of files) records.push({ manifest: await readJson(filePath), _path: filePath });
  return records;
}

async function findEventManifest(eventId) {
  if (!eventId) return null;
  const records = await loadEventRecords();
  const found = records.find((record) => record.manifest.event_id === eventId);
  return found ? { manifest: found.manifest, _path: found._path } : null;
}

async function findTopicManifest(topicId) {
  if (!topicId) return null;
  const topicPath = path.join(cardsRoot, "topics", topicId, "topic.json");
  const topic = await readJson(topicPath, null);
  return topic ? { ...topic, _path: topicPath } : null;
}

async function locateSource(directory, originalFilename) {
  const direct = path.join(directory, originalFilename || "");
  if (originalFilename && await exists(direct)) return direct;
  const files = await walkFiles(directory, (filePath) => path.basename(filePath) !== "intake.json" && path.basename(filePath) !== "review.json");
  return files[0] || null;
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizePerson(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized.includes("vivi")) return "vivi";
  if (normalized.includes("zac")) return "zac";
  return normalized;
}

function displayOwner(value) {
  return normalizePerson(value) === "vivi" ? "Vivi" : "Zac";
}

function stringArray(value) {
  if (!Array.isArray(value)) return value ? [String(value).trim()].filter(Boolean) : [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function normalizeDate(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function compactDate(value) {
  const date = new Date(value || Date.now());
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("");
}

function earlierDate(left, right) {
  if (!left) return right;
  if (!right) return left;
  return String(left).localeCompare(String(right)) <= 0 ? left : right;
}

function laterDate(left, right) {
  if (!left) return right;
  if (!right) return left;
  return String(left).localeCompare(String(right)) >= 0 ? left : right;
}

async function audit(event, detail) {
  await appendJsonLine(ingestionLog, { at: new Date().toISOString(), event, ...detail });
}
