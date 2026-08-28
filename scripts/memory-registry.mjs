import fs from "node:fs/promises";
import path from "node:path";
import {
  appendJsonLine,
  parseFrontmatter,
  randomId,
  walkFiles
} from "./card-v1-lib.mjs";
import {
  assertMemoryCandidate,
  validateMemoryFile
} from "./memory-policy.mjs";

export const MEMORY_ROOT_NAME = "10-memory";
const MEMORY_DIRS = new Set(["people", "dictionary", "project", "consensus", "corrections", "methods"]);

export async function listMemoryFiles(workspaceRoot) {
  const root = path.join(workspaceRoot, MEMORY_ROOT_NAME);
  return walkFiles(root, isMemoryRecordFile);
}

export async function listValidatedMemoryRecords(workspaceRoot, { includeNavigation = true } = {}) {
  const root = path.join(workspaceRoot, MEMORY_ROOT_NAME);
  const files = await walkFiles(root, isMemoryRecordFile);
  const records = [];
  for (const filePath of files) {
    const parsed = parseFrontmatter(await fs.readFile(filePath, "utf8"));
    const memoryType = String(parsed.data.memory_type || "");
    const navigation = ["navigation", "retrieval_rules", "consensus_index", "corrections_index", "project_context", "methods_index"].includes(memoryType);
    if (!includeNavigation && navigation) continue;
    const record = await validateMemoryFile(workspaceRoot, filePath, { allowNavigation: includeNavigation });
    records.push({ ...record, file_path: path.relative(workspaceRoot, filePath).split(path.sep).join("/") });
  }
  return records;
}

// README and retrieval-rules are navigation documents, not Memory records.
// Keep this boundary structural so a navigation file without frontmatter
// cannot prevent a valid Memory write from being indexed.
function isMemoryRecordFile(filePath) {
  const basename = path.basename(filePath).toLowerCase();
  return path.extname(filePath).toLowerCase() === ".md"
    && !basename.startsWith("readme")
    && basename !== "retrieval-rules.md";
}

export async function createMemoryRecord(workspaceRoot, input) {
  assertMemoryCandidate(input);
  const category = categoryForType(input.memory_type);
  const memoryId = String(input.memory_id || randomId("memory-", 8));
  const existingRecords = await listValidatedMemoryRecords(workspaceRoot, { includeNavigation: true });
  const existing = existingRecords.find((record) => record.memory_id === memoryId && record.status === "active");
  if (existing) return { memory_id: existing.memory_id, file_path: existing.file_path, created: false, deduplicated: true };
  const slug = String(input.slug || memoryId).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const filePath = path.join(workspaceRoot, MEMORY_ROOT_NAME, category, `${slug || memoryId}.md`);
  try {
    await fs.access(filePath);
    throw new Error(`Memory file already exists: ${filePath}`);
  } catch (error) {
    if (error.message.startsWith("Memory file already exists")) throw error;
    if (error.code !== "ENOENT") throw error;
  }
  const now = input.updated_at || new Date().toISOString();
  for (const sourceRef of input.source_refs || []) {
    if (/^https?:\/\//i.test(String(sourceRef))) continue;
    const sourcePath = path.resolve(workspaceRoot, String(sourceRef));
    if (!sourcePath.startsWith(path.resolve(workspaceRoot) + path.sep)) {
      throw new Error(`Memory source is outside workspace: ${sourceRef}`);
    }
    await fs.access(sourcePath);
  }
  const document = renderMemoryDocument({ ...input, memory_id: memoryId, status: input.status || "active", fact_status: "confirmed", updated_at: now });
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o2775 });
  await fs.writeFile(filePath, document, { mode: 0o664, flag: "wx" });
  await appendMemoryAudit(workspaceRoot, { type: "created", memory_id: memoryId, memory_type: input.memory_type, path: path.relative(workspaceRoot, filePath), source_refs: input.source_refs || [] });
  try {
    await validateMemoryFile(workspaceRoot, filePath);
  } catch (error) {
    await fs.rm(filePath, { force: true });
    throw error;
  }
  return { memory_id: memoryId, file_path: path.relative(workspaceRoot, filePath).split(path.sep).join("/"), created: true, deduplicated: false };
}

export async function upsertMethodRecord(workspaceRoot, input) {
  const memoryId = String(input.memory_id || "").trim();
  if (!memoryId) return createMemoryRecord(workspaceRoot, { ...input, memory_type: "method" });
  const records = await listValidatedMemoryRecords(workspaceRoot, { includeNavigation: true });
  const existing = records.find((record) => record.memory_id === memoryId && record.status === "active");
  if (!existing) return createMemoryRecord(workspaceRoot, { ...input, memory_type: "method" });

  const oldData = existing.data || {};
  const merged = {
    ...oldData,
    ...input,
    memory_id: memoryId,
    memory_type: "method",
    status: "active",
    fact_status: "confirmed",
    source_refs: mergeStringArrays(oldData.source_refs, input.source_refs),
    human_event_ids: mergeStringArrays(oldData.human_event_ids, input.human_event_ids),
    supporting_card_ids: mergeStringArrays(oldData.supporting_card_ids, input.supporting_card_ids),
    updated_at: new Date().toISOString()
  };
  const filePath = path.resolve(workspaceRoot, existing.file_path);
  await fs.writeFile(filePath, renderMemoryDocument(merged), { mode: 0o664 });
  await validateMemoryFile(workspaceRoot, filePath);
  await appendMemoryAudit(workspaceRoot, {
    type: "reinforced",
    memory_id: memoryId,
    memory_type: "method",
    path: existing.file_path,
    source_refs: merged.source_refs
  });
  return { memory_id: memoryId, file_path: existing.file_path, created: false, deduplicated: false, reinforced: true };
}

export async function supersedeMemoryRecord(workspaceRoot, oldFilePath, input) {
  const oldAbsolute = path.resolve(workspaceRoot, oldFilePath);
  const old = await validateMemoryFile(workspaceRoot, oldAbsolute);
  const replacement = await createMemoryRecord(workspaceRoot, { ...input, supersedes: old.memory_id });
  const oldParsed = parseFrontmatter(await fs.readFile(oldAbsolute, "utf8"));
  const oldDocument = renderMemoryDocument({ ...oldParsed.data, status: "superseded", fact_status: "confirmed", updated_at: new Date().toISOString() }, oldParsed.body);
  await fs.writeFile(oldAbsolute, oldDocument, { mode: 0o664 });
  await appendMemoryAudit(workspaceRoot, { type: "superseded", memory_id: old.memory_id, replacement_memory_id: replacement.memory_id, path: oldFilePath });
  return replacement;
}

export async function appendMemoryAudit(workspaceRoot, entry) {
  const auditPath = path.join(workspaceRoot, ".hermes", "audit", "memory.jsonl");
  await fs.mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
  await fs.appendFile(auditPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  await fs.chmod(auditPath, 0o600).catch(() => {});
}

export function categoryForType(memoryType) {
  const type = String(memoryType || "");
  if (type === "person_profile") return "people";
  if (type === "person_fact") return "people/facts";
  if (type === "dictionary") return "dictionary";
  if (type.startsWith("project_")) return "project";
  if (type === "consensus") return "consensus/records";
  if (type.includes("correction")) return "corrections/records";
  if (type === "method") return "methods/records";
  throw new Error(`Memory type cannot be placed automatically: ${memoryType}`);
}

export function renderMemoryDocument(input, bodyOverride = "") {
  const lines = ["---"];
  const scalarKeys = ["memory_id", "memory_type", "person", "scope", "status", "fact_status", "evidence_type", "title", "statement", "summary", "term", "meaning", "not_meaning", "project_role", "supersedes", "updated_at", "correction_type", "original_behavior", "correct_behavior", "task_id", "task_card_id"];
  for (const key of scalarKeys) {
    if (input[key] === undefined || input[key] === null || input[key] === "") continue;
    lines.push(`${key}: ${yamlScalar(input[key])}`);
  }
  if (Array.isArray(input.source_refs)) {
    lines.push("source_refs:");
    for (const source of input.source_refs) lines.push(`  - ${yamlScalar(source)}`);
  }
  for (const key of ["human_event_ids", "supporting_card_ids", "opposing_card_ids", "applies_to_actions", "target_refs", "verification_refs", "resolution_task_ids"]) {
    if (!Array.isArray(input[key])) continue;
    lines.push(`${key}:`);
    for (const value of input[key]) lines.push(`  - ${yamlScalar(value)}`);
  }
  for (const key of ["applicable_when", "not_applicable_when"]) {
    if (!Array.isArray(input[key])) continue;
    lines.push(`${key}:`);
    for (const value of input[key]) lines.push(`  - ${yamlScalar(value)}`);
  }
  lines.push("---", "");
  lines.push(bodyOverride || String(input.body || input.statement || input.meaning || "").trim(), "");
  return lines.join("\n");
}

function yamlScalar(value) {
  return JSON.stringify(String(value));
}

function mergeStringArrays(...values) {
  return [...new Set(values.flatMap((value) => Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean))];
}
