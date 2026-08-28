#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  arrayValue,
  cardContentHash,
  excerpt,
  extractDate,
  extractSectionItems,
  extractTitle,
  getWorkspaceRoot,
  isTextFile,
  normalizeSlug,
  normalizeSummaryPoints,
  parseFrontmatter,
  publicUrl,
  readJson,
  relativePath,
  fallbackSummaryPoints,
  unique,
  walkFiles,
  writeJsonAtomic
} from "./card-v1-lib.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = getWorkspaceRoot(scriptDirectory);
const cardsRoot = path.join(workspaceRoot, "08-cards");
const indexPath = path.join(cardsRoot, "card_index.json");
const legacyCardsDir = path.join(cardsRoot, "cards");
const legacyContentsDir = path.join(cardsRoot, "contents");
const eventsDir = path.join(cardsRoot, "events");
const humanEventsDir = path.join(cardsRoot, "human-events", "records");
const topicsDir = path.join(cardsRoot, "topics");
const tasksDir = path.join(workspaceRoot, "09-tasks", "tasks");
const briefingsDir = path.join(workspaceRoot, "05-agent-outputs", "project-hermes", "meeting-briefings");

const manifests = await loadEventManifests();
const eventByCardId = new Map();
for (const manifest of manifests) {
  for (const cardId of manifest.card_ids || []) eventByCardId.set(String(cardId), manifest.event_id);
}

const contentFiles = await walkFiles(legacyContentsDir, isTextFile);
const contentById = new Map();
for (const filePath of contentFiles) {
  const entry = await readTextEntry(filePath);
  contentById.set(entry.id, entry);
}

const legacyCardFiles = await walkFiles(legacyCardsDir, isTextFile);
const eventCardFiles = await walkFiles(eventsDir, (filePath) => isTextFile(filePath) && path.basename(path.dirname(filePath)) === "cards");
const allCards = [];
for (const filePath of unique([...legacyCardFiles, ...eventCardFiles])) {
  const entry = await readTextEntry(filePath);
  const contentId = normalizeSlug(entry.data.content_id || entry.data.contentId || entry.id);
  const content = contentById.get(contentId) || null;
  const humanEventId = String(entry.data.human_event_id || "").trim();
  const topicId = String(entry.data.topic_id || "").trim();
  const eventId = String(entry.data.event_id || eventByCardId.get(entry.id) || humanEventId || "").trim();
  const occurredAt = entry.date.toISOString();
  const participants = arrayValue(entry.data.participants || entry.data.people || entry.data["参与者"]);
  const cardType = String(entry.data.card_type || (participants.length > 1 ? "collaboration" : "personal"));
  const placementType = ["human_event", "topic", "event", "unplaced"].includes(String(entry.data.placement_type || "").toLowerCase())
    ? String(entry.data.placement_type).toLowerCase()
    : (humanEventId ? "human_event" : (topicId ? "topic" : (eventId ? "event" : "unplaced")));
  const extractedKeyPoints = firstSection(entry.body, [
    "卡片要点", "Hermes 摘要", "卡片摘要", "结果摘要", "Task Result", "fact", "facts", "事实", "关键信息",
    "我的判断", "个人判断", "视角", "perspectives", "对候选 Topic 的意见", "对候选 Task 的意见",
    "展示反馈", "共识", "讨论结论", "当前结论", "结论", "最终结论", "下一步", "next", "next steps"
  ]);
  const keyPoints = normalizeSummaryPoints(extractedKeyPoints).length
    ? normalizeSummaryPoints(extractedKeyPoints)
    : fallbackSummaryPoints(entry.body, entry.title, 3);
  const test = entry.data.test === true || String(entry.data.test || "") === "true";
  const sourceRefs = unique([
    ...arrayValue(entry.data.source_refs || entry.data.source_ref),
    content ? content.relative_path : ""
  ]);
  allCards.push({
    card_id: entry.id,
    event_id: eventId,
    card_type: cardType,
    human_event_id: humanEventId,
    topic_id: topicId,
    placement_type: placementType,
    placement_id: String(entry.data.placement_id || (placementType === "topic" ? topicId : humanEventId || eventId || "")),
    task_id: String(entry.data.task_id || ""),
    author: String(entry.data.author || ""),
    title: entry.title,
    occurred_at: occurredAt,
    created_at: occurredAt,
    submitted_at: entry.stats.mtime.toISOString(),
    year: String(entry.date.getFullYear()),
    month: String(entry.date.getMonth() + 1).padStart(2, "0"),
    participants,
    summary: String(entry.data.summary || keyPoints[0] || ""),
    summary_method: String(entry.data.summary_method || "indexed-fallback"),
    key_points: keyPoints,
    perspectives: firstSection(entry.body, ["视角", "perspectives", "Zac 的关注", "Vivi 的关注"]),
    conclusions: firstSection(entry.body, ["讨论结论", "当前结论", "已达成的一致", "讨论所得判断", "可复用决策", "最终结论"]),
    next_steps: firstSection(entry.body, ["下一步", "next", "next steps", "next_step"]),
    source_refs: sourceRefs,
    card_path: entry.relative_path,
    card_url: entry.url,
    content_id: content ? content.id : contentId,
    content_path: content ? content.relative_path : null,
    content_url: content ? content.url : firstSourceUrl(sourceRefs),
    status: content || sourceRefs.length ? "indexed" : "content_missing",
    lifecycle_status: String(entry.data.lifecycle_status || "accepted").toLowerCase(),
    content_hash: String(entry.data.content_hash || cardContentHash(entry.data, entry.body)),
    revision_group_id: String(entry.data.revision_group_id || ""),
    revision_number: Number(entry.data.revision_number || 1),
    supersedes_card_id: String(entry.data.supersedes_card_id || ""),
    superseded_by_card_id: String(entry.data.superseded_by_card_id || ""),
    excerpt: excerpt(entry.body),
    card_text: entry.body,
    content_excerpt: content ? excerpt(content.body) : "",
    content_text: content ? content.body : "",
    html_card_url: entry.data.html_card_url || null,
    test
  });
}

const cardRank = (card) => card.lifecycle_status === "accepted" ? 3 : (card.lifecycle_status === "superseded" ? 2 : 1);
const cardById = new Map();
for (const card of allCards) {
  const existing = cardById.get(card.card_id);
  if (!existing || cardRank(card) > cardRank(existing)) cardById.set(card.card_id, card);
}
const dedupedCards = [...cardById.values()];
const revisionCards = dedupedCards.filter((card) => card.lifecycle_status === "superseded");
const cards = dedupedCards.filter((card) => card.lifecycle_status === "accepted");
cards.sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)));

const cardsByEvent = new Map();
for (const card of cards) {
  if (!card.event_id) continue;
  if (!cardsByEvent.has(card.event_id)) cardsByEvent.set(card.event_id, []);
  cardsByEvent.get(card.event_id).push(card);
}

const events = [];
const knownEventIds = new Set();
for (const manifest of manifests) {
  knownEventIds.add(manifest.event_id);
  events.push(buildEvent(manifest, cardsByEvent.get(manifest.event_id) || []));
}
for (const [eventId, eventCards] of cardsByEvent.entries()) {
  if (knownEventIds.has(eventId)) continue;
  events.push(buildEvent({
    event_id: eventId,
    title: eventCards[0]?.title || "Legacy event",
    status: "active",
    source_refs: [],
    related_event_ids: [],
    merged_into: null,
    test: eventCards.every((card) => card.test)
  }, eventCards));
}
events.sort((a, b) => String(b.latest_activity_at).localeCompare(String(a.latest_activity_at)));

const tasks = await loadTasks();
const index = {
  schema_version: 3,
  generated_at: new Date().toISOString(),
  workspace: "collab_workspace",
  source_dirs: {
    inbox: ["08-cards/inbox/zac-draft", "08-cards/inbox/vivi-draft"],
    events: "08-cards/events",
    human_events: "08-cards/human-events/records",
    topics: "08-cards/topics",
    tasks: "09-tasks/tasks",
    legacy_cards: "08-cards/cards",
    legacy_contents: "08-cards/contents"
  },
  event_count: events.filter((event) => !event.test).length,
  card_count: cards.filter((card) => !card.test).length,
  test_event_count: events.filter((event) => event.test).length,
  test_card_count: cards.filter((card) => card.test).length,
  events,
  cards,
  card_revisions: revisionCards,
  human_events: await loadHumanEvents(),
  topics: (await loadTopics()).filter((topic) => topic.test !== true),
  briefings: (await loadBriefings()).filter((briefing) => briefing.test !== true),
  tasks
};

await writeJsonAtomic(indexPath, index);
await writeTaskIndex(tasks);
console.log("indexed " + cards.length + " card(s) across " + events.length + " event(s) -> " + indexPath);

async function loadEventManifests() {
  const paths = await walkFiles(eventsDir, (filePath) => path.basename(filePath) === "event.json");
  const out = [];
  for (const filePath of paths) {
    const manifest = await readJson(filePath);
    manifest._path = relativePath(workspaceRoot, filePath);
    out.push(manifest);
  }
  return out;
}

async function readTextEntry(filePath) {
  const stats = await fs.stat(filePath);
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = parseFrontmatter(raw);
  const fallbackName = path.basename(filePath, path.extname(filePath));
  const id = normalizeSlug(parsed.data.card_id || parsed.data.content_id || fallbackName.replace(/^(card|content)-/, ""));
  return {
    id,
    data: parsed.data,
    body: parsed.body.trim(),
    title: extractTitle(parsed, fallbackName),
    date: extractDate(parsed, path.basename(filePath), stats),
    stats,
    relative_path: relativePath(workspaceRoot, filePath),
    url: publicUrl(workspaceRoot, filePath)
  };
}

function firstSection(text, headings) {
  return extractSectionItems(text, headings);
}

function firstSourceUrl(sourceRefs) {
  const ref = sourceRefs.find((item) => String(item).startsWith("08-cards/"));
  return ref ? "/collaborate/" + ref.split("/").map(encodeURIComponent).join("/") : null;
}

function buildEvent(manifest, eventCards) {
  const dates = eventCards.map((card) => card.occurred_at).filter(Boolean).sort();
  const sourceRefs = unique([
    ...(manifest.source_refs || []),
    ...eventCards.flatMap((card) => card.source_refs || [])
  ]);
  return {
    event_id: manifest.event_id,
    title: manifest.title || eventCards[0]?.title || "Untitled event",
    status: manifest.status || "active",
    first_occurred_at: manifest.first_occurred_at || dates[0] || null,
    latest_activity_at: manifest.latest_activity_at || dates[dates.length - 1] || null,
    participants: unique([...(manifest.participants || []), ...eventCards.flatMap((card) => card.participants || [])]),
    summary: String(manifest.summary || ""),
    key_points: normalizeSummaryPoints(manifest.key_points).length
      ? normalizeSummaryPoints(manifest.key_points)
      : fallbackSummaryPoints(manifest.summary || manifest.title, manifest.title, 3),
    card_ids: unique(eventCards.map((card) => card.card_id)),
    card_count: eventCards.length,
    source_refs: sourceRefs,
    related_event_ids: manifest.related_event_ids || [],
    merged_into: manifest.merged_into || null,
    test: manifest.test === true || (eventCards.length > 0 && eventCards.every((card) => card.test)),
    event_path: manifest._path || null
  };
}


async function loadHumanEvents() {
  const files = await walkFiles(humanEventsDir, (filePath) => path.basename(filePath) === "event.json");
  const out = [];
  for (const filePath of files) {
    const event = await readJson(filePath, null);
    if (!event) continue;
    const acceptedIds = new Set(cards.filter((card) => card.human_event_id === event.human_event_id).map((card) => card.card_id));
    const eventRevisionCards = revisionCards.filter((card) => card.human_event_id === event.human_event_id);
    const normalizedRevisionGroups = Object.fromEntries(Object.entries(event.card_revision_ids_by_author || {}).map(([author, ids]) => [
      author,
      unique([...(Array.isArray(ids) ? ids : []), ...eventRevisionCards
        .filter((card) => String(card.author || "").toLowerCase().includes(author))
        .map((card) => card.card_id)])
    ]));
    out.push({
      ...event,
      personal_card_ids: (event.personal_card_ids || []).filter((cardId) => acceptedIds.has(cardId)),
      card_revision_ids: unique([...(event.card_revision_ids || []), ...eventRevisionCards.map((card) => card.card_id)]),
      card_revision_ids_by_author: normalizedRevisionGroups,
      key_points: normalizeSummaryPoints(event.key_points).length
        ? normalizeSummaryPoints(event.key_points)
        : fallbackSummaryPoints(event.summary || event.title, event.title, 3),
      event_path: relativePath(workspaceRoot, filePath),
      review_path: event.review_path || relativePath(workspaceRoot, path.join(path.dirname(filePath), "review.json")),
      source_refs: event.source_refs || []
    });
  }
  return out.sort((a, b) => String(b.occurred_at || b.updated_at).localeCompare(String(a.occurred_at || a.updated_at)));
}

async function loadTopics() {
  const files = await walkFiles(topicsDir, (filePath) => path.basename(filePath) === "topic.json");
  const out = [];
  for (const filePath of files) {
    const topic = await readJson(filePath, null);
    if (!topic) continue;
    out.push({
      ...topic,
      key_points: normalizeSummaryPoints(topic.key_points).length
        ? normalizeSummaryPoints(topic.key_points)
        : fallbackSummaryPoints(topic.current_summary || topic.summary || topic.title, topic.title, 1),
      topic_path: relativePath(workspaceRoot, filePath)
    });
  }
  return out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

async function loadTasks() {
  const files = await walkFiles(tasksDir, (filePath) => path.basename(filePath) === "task.json");
  const out = [];
  for (const filePath of files) {
    const task = await readJson(filePath, null);
    if (!task) continue;
    out.push({
      ...task,
      task_path: relativePath(workspaceRoot, filePath),
      audit_path: relativePath(workspaceRoot, path.join(path.dirname(filePath), "audit.jsonl"))
    });
  }
  return out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

async function loadBriefings() {
  const files = await walkFiles(briefingsDir, (filePath) => path.basename(filePath).endsWith(".json") && !filePath.includes(`${path.sep}reviews${path.sep}`));
  const out = [];
  for (const filePath of files) {
    const briefing = await readJson(filePath, null);
    if (Number(briefing?.schema_version) < 2 || !briefing?.briefing_id || !briefing?.topic_id) continue;
    const relativeJson = relativePath(workspaceRoot, filePath);
    const markdownPath = briefing.final_path || briefing.markdown_path || briefing.draft_path || "";
    out.push({
      ...briefing,
      json_path: briefing.json_path || relativeJson,
      json_url: publicUrl(workspaceRoot, filePath),
      markdown_url: briefing.final_url || briefing.markdown_url || (markdownPath ? publicUrl(workspaceRoot, path.join(workspaceRoot, markdownPath)) : null),
      briefing_path: relativeJson,
      summary_points: normalizeSummaryPoints(briefing.summary_points).length
        ? normalizeSummaryPoints(briefing.summary_points)
        : fallbackSummaryPoints(briefing.current_progress?.summary || briefing.meeting_goal || briefing.title, briefing.title, 3)
    });
  }
  return out.sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
}

async function writeTaskIndex(tasks) {
  const taskIndexPath = path.join(workspaceRoot, "09-tasks", "task_index.json");
  const taskRecords = tasks.map((task) => ({
    ...task,
    task_card_url: task.task_card_id ? `/collaborate/08-cards/cards/card-${task.task_card_id}.md` : null
  }));
  await writeJsonAtomic(taskIndexPath, {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    task_count: taskRecords.length,
    tasks: taskRecords
  });
}
