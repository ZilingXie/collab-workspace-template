import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "./card-v1-lib.mjs";

const UNCERTAINTY_PATTERN = /(?:可能|似乎|大概|或许|推测|猜测|猜想|待确认|未确认|不确定|perhaps|maybe|possibly|probably|speculat(?:e|ion)|unconfirmed|uncertain|\bmay\b|\bmight\b|\bcould\b)/iu;
const ALLOWED_EVIDENCE = new Set([
  "human_statement",
  "human_correction",
  "confirmed_human_event",
  "authority_pointer"
]);
const NAVIGATION_TYPES = new Set([
  "navigation",
  "retrieval_rules",
  "consensus_index",
  "corrections_index",
  "project_context",
  "methods_index"
]);

export class MemoryPolicyError extends Error {
  constructor(code, message = code, details = {}) {
    super(message);
    this.name = "MemoryPolicyError";
    this.code = code;
    this.details = details;
  }
}

export function validateMemoryRecord(workspaceRoot, record, { filePath = "", allowNavigation = true } = {}) {
  const data = record?.data || record || {};
  const body = String(record?.body || data.body || "");
  const memoryType = String(data.memory_type || "").trim();
  if (!String(data.memory_id || "").trim()) reject("MEMORY_ID_REQUIRED", "Memory requires memory_id");
  if (!memoryType) reject("MEMORY_TYPE_REQUIRED", "Memory requires memory_type");
  if (!allowNavigation && NAVIGATION_TYPES.has(memoryType)) {
    reject("MEMORY_NAVIGATION_NOT_A_FACT", "Navigation documents cannot be promoted as facts");
  }
  if (data.status && !["active", "superseded", "rejected"].includes(String(data.status))) {
    reject("MEMORY_STATUS_INVALID", `Unsupported Memory status: ${data.status}`);
  }
  if (data.fact_status !== "confirmed") {
    reject("MEMORY_FACT_NOT_CONFIRMED", "Only confirmed Memory may be written as a fact");
  }
  if (!ALLOWED_EVIDENCE.has(String(data.evidence_type || ""))) {
    reject("MEMORY_EVIDENCE_TYPE_REQUIRED", "Memory requires an allowed evidence_type");
  }
  const sourceRefs = normalizeRefs(data.source_refs);
  if (!sourceRefs.length) reject("MEMORY_SOURCE_REQUIRED", "Memory requires at least one source_ref");
  for (const sourceRef of sourceRefs) {
    if (/^https?:\/\//i.test(sourceRef)) continue;
    const absolute = path.resolve(workspaceRoot, sourceRef);
    if (!absolute.startsWith(path.resolve(workspaceRoot) + path.sep) && absolute !== path.resolve(workspaceRoot)) {
      reject("MEMORY_SOURCE_OUTSIDE_WORKSPACE", `Memory source is outside workspace: ${sourceRef}`);
    }
    if (!filePath || absolute !== path.resolve(filePath)) {
      // A source may be a path in a future event record; existence is checked by the registry.
    }
  }
  const factText = [
    data.statement,
    data.title,
    data.summary,
    data.meaning,
    data.role,
    data.project_role,
    data.content,
    ...(Array.isArray(data.applicable_when) ? data.applicable_when : []),
    ...(Array.isArray(data.not_applicable_when) ? data.not_applicable_when : [])
  ].filter((value) => typeof value === "string").join("\n");
  if (!NAVIGATION_TYPES.has(memoryType) && UNCERTAINTY_PATTERN.test(factText)) {
    reject("MEMORY_SPECULATION_FORBIDDEN", "Speculation or unresolved language cannot be written as Memory");
  }
  return {
    memory_id: String(data.memory_id),
    memory_type: memoryType,
    status: String(data.status || "active"),
    fact_status: String(data.fact_status),
    evidence_type: String(data.evidence_type),
    source_refs: sourceRefs,
    supersedes: data.supersedes ? String(data.supersedes) : null
  };
}

export async function validateMemoryFile(workspaceRoot, filePath, options = {}) {
  const text = await fs.readFile(filePath, "utf8");
  const parsed = parseFrontmatter(text);
  const summary = validateMemoryRecord(workspaceRoot, parsed, { ...options, filePath });
  for (const sourceRef of summary.source_refs) {
    if (/^https?:\/\//i.test(sourceRef)) continue;
    const sourcePath = path.resolve(workspaceRoot, sourceRef);
    if (!sourcePath.startsWith(path.resolve(workspaceRoot) + path.sep)) {
      throw new MemoryPolicyError("MEMORY_SOURCE_OUTSIDE_WORKSPACE", `Memory source is outside workspace: ${sourceRef}`);
    }
    try {
      await fs.access(sourcePath);
    } catch {
      throw new MemoryPolicyError("MEMORY_SOURCE_MISSING", `Memory source does not exist: ${sourceRef}`);
    }
  }
  return { ...summary, data: parsed.data, body: parsed.body };
}

export function assertMemoryCandidate(input) {
  const evidenceType = String(input?.evidence_type || "");
  const factStatus = String(input?.fact_status || "");
  if (factStatus !== "confirmed") reject("MEMORY_FACT_NOT_CONFIRMED", "Candidate is not confirmed");
  if (!ALLOWED_EVIDENCE.has(evidenceType)) reject("MEMORY_EVIDENCE_TYPE_REQUIRED", "Candidate evidence is not allowed");
  if (!normalizeRefs(input?.source_refs).length) reject("MEMORY_SOURCE_REQUIRED", "Candidate requires source_refs");
  const text = [input.statement, input.meaning, input.role, input.content].filter(Boolean).join("\n");
  if (UNCERTAINTY_PATTERN.test(text)) reject("MEMORY_SPECULATION_FORBIDDEN", "Speculation cannot become Memory");
  return true;
}

export function normalizeRefs(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (value) return [String(value).trim()].filter(Boolean);
  return [];
}

function reject(code, message) {
  throw new MemoryPolicyError(code, message);
}
