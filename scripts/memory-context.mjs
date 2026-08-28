import fs from "node:fs/promises";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { randomId } from "./card-v1-lib.mjs";
import { listValidatedMemoryRecords } from "./memory-registry.mjs";

const MEMORY_ROOT = "10-memory";
const ROUTES = {
  all: ["README.md", "retrieval-rules.md", "project/identity.md", "project/context.md", "people/zac.md", "people/vivi.md", "people/hermes.md", "dictionary/terms.md", "consensus/index.md", "methods/index.md"],
  project: ["project/identity.md", "project/context.md"],
  zac: ["people/zac.md"],
  vivi: ["people/vivi.md"],
  hermes: ["people/hermes.md"],
  dictionary: ["dictionary/terms.md"],
  consensus: ["consensus/index.md"],
  methods: ["methods/index.md"]
};

const ACTION_ROUTES = {
  task_assignment: ["people", "consensus", "methods", "corrections"],
  identity_resolution: ["people", "project", "corrections"],
  human_event_ingest: ["people", "project", "consensus", "methods", "corrections"],
  project_status_query: ["project", "consensus", "corrections"],
  memory_write_and_correction: ["people", "project", "consensus", "corrections"],
  meeting_briefing: ["people", "consensus", "methods", "corrections"],
  quoted_message_explanation: ["people", "dictionary", "consensus", "project", "corrections"],
  disagreement_analysis: ["people", "consensus", "corrections", "methods"],
  personal_card_generation: ["people", "dictionary", "project", "corrections"],
  project_question: ["project", "consensus", "corrections"],
  term_resolution: ["dictionary", "consensus", "corrections"]
};

export async function readMemoryContext(workspaceRoot, route = "all", { maxChars = 18000 } = {}) {
  const relativePaths = ROUTES[route] || ROUTES.all;
  let remaining = maxChars;
  const sections = [];
  for (const relativePath of relativePaths) {
    if (remaining <= 0) break;
    const filePath = path.join(workspaceRoot, MEMORY_ROOT, relativePath);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf8");
    const text = content.slice(0, remaining);
    remaining -= text.length;
    sections.push({
      path: path.join(MEMORY_ROOT, relativePath).split(path.sep).join("/"),
      content: text,
      truncated: text.length < content.length
    });
  }
  if (route === "methods" && remaining > 0) {
    const recordsRoot = path.join(workspaceRoot, MEMORY_ROOT, "methods", "records");
    let entries = [];
    try { entries = await fs.readdir(recordsRoot); } catch { entries = []; }
    for (const name of entries.filter((item) => item.endsWith(".md")).sort()) {
      if (remaining <= 0) break;
      const filePath = path.join(recordsRoot, name);
      const content = readFileSync(filePath, "utf8");
      const text = content.slice(0, remaining);
      remaining -= text.length;
      sections.push({
        path: path.join(MEMORY_ROOT, "methods", "records", name).split(path.sep).join("/"),
        content: text,
        truncated: text.length < content.length
      });
    }
  }
  return sections;
}

/**
 * Build the bounded, auditable memory input for one Hermes action.
 * Dynamic project facts are represented by refs and loaded by the caller.
 */
export async function buildMemoryContext({
  workspaceRoot,
  action,
  requester = "",
  subjectPerson = "",
  participants = [],
  humanEventId = "",
  topicId = "",
  taskId = "",
  maxChars = 24000
}) {
  const normalizedAction = String(action || "").trim().replaceAll("-", "_");
  if (!ACTION_ROUTES[normalizedAction]) throw new Error(`Unsupported memory action: ${normalizedAction}`);
  const people = [...new Set([requester, subjectPerson, ...(Array.isArray(participants) ? participants : [])]
    .map(normalizePerson)
    .filter(Boolean))];
  const requestedRoutes = ACTION_ROUTES[normalizedAction];
  const memoryRecords = await listValidatedMemoryRecords(workspaceRoot, { includeNavigation: true });
  const activeRecords = memoryRecords.filter((record) => record.status === "active" && record.fact_status === "confirmed");
  const selected = activeRecords.filter((record) => recordMatchesAction(record, requestedRoutes, people, normalizedAction));
  const selectedById = new Map(selected.map((record) => [record.memory_id, record]));
  let remaining = maxChars;
  const memory = [];
  for (const record of selected) {
    if (remaining <= 0) break;
    const content = String(record.body || "").slice(0, remaining);
    remaining -= content.length;
    memory.push({
      memory_id: record.memory_id,
      memory_type: record.memory_type,
      path: record.file_path,
      content,
      truncated: content.length < String(record.body || "").length
    });
  }
  const missingInformation = [];
  if (["task_assignment", "meeting_briefing"].includes(normalizedAction)) {
    for (const person of people) {
      if (!selected.some((record) => normalizePerson(record.data?.person) === person)) {
        missingInformation.push(`${person} 的人物画像没有足够的已确认信息`);
      }
    }
  }
  const dynamicRefs = [
    humanEventId ? `08-cards/human-events/records/${humanEventId}` : "",
    topicId ? `08-cards/topics/${topicId}/topic.json` : "",
    taskId ? `09-tasks/tasks/${taskId}/task.json` : "",
    normalizedAction === "meeting_briefing" ? "08-cards/card_index.json" : "",
    normalizedAction === "meeting_briefing" ? "09-tasks/task_index.json" : ""
  ].filter(Boolean);
  const restrictions = [
    "只使用 active 且 fact_status=confirmed 的 Memory 作为事实。",
    "人物画像不能覆盖当次原话，动态进度必须从 Card/Topic/Task 等实时来源读取。",
    "推测只能作为待确认假设，不能写入 Memory。"
  ];
  return {
    usage_id: randomId("memory-use-", 8),
    action: normalizedAction,
    requester: String(requester || "").trim(),
    subject_person: String(subjectPerson || "").trim(),
    participants: people,
    memory_refs: [...selectedById.keys()],
    memory,
    dynamic_refs: dynamicRefs,
    confirmed_context: memory.map((item) => ({ memory_id: item.memory_id, path: item.path })),
    working_hypotheses: [],
    missing_information: missingInformation,
    restrictions
  };
}

function recordMatchesAction(record, routes, people, action) {
  const type = String(record.memory_type || "");
  if (type === "person_profile") return routes.includes("people") && (!people.length || people.includes(normalizePerson(record.data?.person)));
  if (type === "person_fact") return routes.includes("people") && (!people.length || people.includes(normalizePerson(record.data?.person)));
  if (type === "dictionary") return routes.includes("dictionary");
  if (type === "consensus") return routes.includes("consensus");
  if (type === "method") return routes.includes("methods");
  if (type.startsWith("project_") || type === "project_context" || type === "project_identity") return routes.includes("project");
  if (type === "correction") {
    if (!routes.includes("corrections")) return false;
    const appliesTo = Array.isArray(record.data?.applies_to_actions) ? record.data.applies_to_actions : [];
    return !appliesTo.length || appliesTo.includes("all") || appliesTo.includes(action);
  }
  return false;
}

function normalizePerson(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text.includes("vivi")) return "vivi";
  if (text.includes("zac")) return "zac";
  if (text.includes("hermes")) return "hermes";
  return text;
}

export async function readMemoryIndexSummary(workspaceRoot, { maxItems = 50 } = {}) {
  const filePath = path.join(workspaceRoot, MEMORY_ROOT, "memory-index.json");
  if (!existsSync(filePath)) return null;
  try {
    const index = JSON.parse(await fs.readFile(filePath, "utf8"));
    const records = Array.isArray(index.records) ? index.records : [];
    const lines = [
      "Source: 10-memory/memory-index.json (navigation summary)",
      `record_count: ${records.length}`,
      "Only records with fact_status=confirmed and status=active are usable as facts.",
      ""
    ];
    for (const record of records.slice(0, maxItems)) {
      lines.push([
        `- memory_id: ${record.memory_id}`,
        `  type: ${record.memory_type}`,
        `  status: ${record.status}`,
        `  fact_status: ${record.fact_status}`,
        `  path: ${record.path}`,
        record.title ? `  title: ${String(record.title).slice(0, 180)}` : ""
      ].filter(Boolean).join("\n"));
    }
    return { path: "10-memory/memory-index.json (summary)", content: lines.join("\n"), truncated: false };
  } catch (error) {
    return { path: "10-memory/memory-index.json (summary)", content: `memory_index_read_error: ${String(error.message || error).slice(0, 500)}`, truncated: false };
  }
}

export function buildMemoryPromptRules() {
  return [
    "File-based project Memory rules:",
    "- 10-memory is a navigation and stable-fact layer, not a copy of Task state.",
    "- Read route-specific files before answering: people for assignment, dictionary for terms, project for project identity, consensus for confirmed shared conclusions, methods for confirmed reusable methods.",
    "- Read 09-tasks/task_index.json and the task record for live Task status.",
    "- Only fact_status=confirmed and status=active Memory is factual.",
    "- Do not turn a hypothesis, model inference, candidate, provisional summary, or missing entry into a fact.",
    "- If project Memory does not define something, say it is undefined or needs confirmation.",
    "- If Memory conflicts with 03-decisions or a live authoritative file, use the authoritative file and report the conflict.",
    "- Never write speculative content to 10-memory. A correction requires an explicit human correction and source_refs."
  ];
}
