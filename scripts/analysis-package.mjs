#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { relativePath, writeJsonAtomic } from "./card-v1-lib.mjs";
import { redactStructured } from "./analysis-security.mjs";

export const ANALYSIS_SCHEMA_VERSION = 2.1;
export const ANALYSIS_ROOT = "02-notes/intakes";
export const RAW_ROOT = "01-raw/intakes";

const ARRAY_FIELDS = [
  "facts",
  "speculations",
  "unknowns",
  "risks",
  "actions",
  "noise",
  "participants",
  "topic_candidates",
  "task_candidates",
  "person_candidates",
  "dictionary_candidates",
  "method_candidates",
  "decision_candidates",
  "memory_proposals",
  "uncertainties",
  "evidence_refs"
];

export function normalizeAnalysisPackage(input, { ingestId = "", sourceRef = "" } = {}) {
  const redacted = redactStructured(input && typeof input === "object" ? input : {});
  const source = redacted.value;
  const signal = source.signal_analysis && typeof source.signal_analysis === "object"
    ? source.signal_analysis : {};
  const event = source.human_event && typeof source.human_event === "object"
    ? source.human_event : {};
  const normalized = {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    ingest_id: String(source.ingest_id || ingestId).trim(),
    source_ref: String(source.source_ref || sourceRef).trim(),
    signal_analysis: Object.fromEntries(ARRAY_FIELDS.slice(0, 6).map((key) => [key, normalizeList(signal[key])])),
    human_event: {
      title: String(event.title || "").trim(),
      summary_points: normalizeList(event.summary_points || event.key_points, 3),
      participants: normalizeList(event.participants),
      agent_participants: normalizeList(event.agent_participants),
      system_actors: normalizeList(event.system_actors),
      source_actor_names: normalizeList(event.source_actor_names || event.participants),
      started_at: normalizeNullable(event.started_at || event.occurred_at),
      ended_at: normalizeNullable(event.ended_at),
      occurred_at: normalizeNullable(event.occurred_at || event.started_at)
    },
    topic_candidates: normalizeCandidates(source.topic_candidates, "topic"),
    task_candidates: normalizeCandidates(source.task_candidates, "task"),
    person_candidates: normalizeCandidates(source.person_candidates, "person"),
    dictionary_candidates: normalizeCandidates(source.dictionary_candidates, "dictionary"),
    method_candidates: normalizeCandidates(source.method_candidates, "method"),
    decision_candidates: normalizeCandidates(source.decision_candidates, "decision"),
    memory_proposals: normalizeCandidates(source.memory_proposals, "memory"),
    uncertainties: normalizeList(source.uncertainties),
    evidence_refs: normalizeList(source.evidence_refs),
    security: {
      redaction_count: redacted.findings.length,
      findings: redacted.findings
    }
  };
  return normalized;
}

export function validateAnalysisPackage(input, { ingestId = "", sourceRef = "" } = {}) {
  const normalized = normalizeAnalysisPackage(input, { ingestId, sourceRef });
  const errors = [];
  if (!normalized.ingest_id) errors.push("ingest_id is required");
  if (!normalized.source_ref) errors.push("source_ref is required");
  if (!normalized.human_event.title) errors.push("human_event.title is required");
  if (!normalized.human_event.summary_points.length) errors.push("human_event.summary_points requires at least one point");
  for (const [key, values] of Object.entries({
    topic_candidates: normalized.topic_candidates,
    task_candidates: normalized.task_candidates,
    person_candidates: normalized.person_candidates,
    dictionary_candidates: normalized.dictionary_candidates,
    method_candidates: normalized.method_candidates,
    decision_candidates: normalized.decision_candidates,
    memory_proposals: normalized.memory_proposals
  })) {
    values.forEach((candidate, index) => {
      if (!candidate.title) errors.push(`${key}[${index}] requires its canonical title field`);
      if (!candidate.source_refs.length) errors.push(`${key}[${index}] requires source_refs`);
      if (!candidate.status) errors.push(`${key}[${index}] requires status`);
      if (key === "memory_proposals" && candidate.target && !String(candidate.target).startsWith("10-memory/")) {
        errors.push(`${key}[${index}].target must be under 10-memory/`);
      }
    });
  }
  if (errors.length) {
    const error = new Error(`Invalid Analysis Package v2: ${errors.join("; ")}`);
    error.code = "ANALYSIS_PACKAGE_INVALID";
    error.details = errors;
    throw error;
  }
  return normalized;
}

export function analysisToProposal(analysis, { sourceRef = "" } = {}) {
  const normalized = validateAnalysisPackage(analysis, {
    ingestId: analysis?.ingest_id,
    sourceRef: sourceRef || analysis?.source_ref
  });
  return {
    title: normalized.human_event.title,
    occurred_at: normalized.human_event.occurred_at,
    participants: normalized.human_event.participants,
    agent_participants: normalized.human_event.agent_participants,
    system_actors: normalized.human_event.system_actors,
    source_actor_names: normalized.human_event.source_actor_names,
    started_at: normalized.human_event.started_at,
    ended_at: normalized.human_event.ended_at,
    summary: normalized.human_event.summary_points.join(" "),
    key_points: normalized.human_event.summary_points,
    topics: normalized.topic_candidates.map((item) => ({
      title: item.title || item.statement,
      summary: item.summary || item.statement || "",
      source_refs: item.source_refs,
      evidence: item.evidence,
      evidence_status: item.evidence_status
    })),
    tasks: normalized.task_candidates.map((item) => ({
      task_id: item.task_id || "",
      title: item.title || item.statement,
      content: item.content || item.summary || item.statement || "",
      topic_title: item.topic_title || "",
      owner: item.owner || item.assignee || "",
      source_status: item.source_status || "",
      candidate_status: item.candidate_status || item.status || "candidate",
      done_criteria: item.done_criteria || "",
      due_date: item.due_date || null,
      risk_level: item.risk_level || "L1",
      source_refs: item.source_refs,
      evidence: item.evidence,
      evidence_status: item.evidence_status
    })),
    method_candidates: normalized.method_candidates,
    analysis: normalized
  };
}

export async function readAnalysisPackage(workspaceRoot, analysisPath) {
  const absolute = path.resolve(workspaceRoot, analysisPath);
  const parsed = JSON.parse(await fs.readFile(absolute, "utf8"));
  return validateAnalysisPackage(parsed, {
    ingestId: parsed?.ingest_id,
    sourceRef: parsed?.source_ref
  });
}

export async function writeAnalysisPackage(workspaceRoot, ingestId, sourceRef, analysis) {
  const normalized = validateAnalysisPackage(analysis, { ingestId, sourceRef });
  const directory = path.join(workspaceRoot, ANALYSIS_ROOT, ingestId);
  await fs.mkdir(directory, { recursive: true, mode: 0o2770 });
  const jsonPath = path.join(directory, "analysis.json");
  const markdownPath = path.join(directory, "analysis.md");
  await writeJsonAtomic(jsonPath, normalized);
  await fs.writeFile(markdownPath, renderAnalysisMarkdown(normalized), { mode: 0o660 });
  await fs.chmod(jsonPath, 0o660);
  return {
    analysis_path: relativePath(workspaceRoot, jsonPath),
    analysis_markdown_path: relativePath(workspaceRoot, markdownPath)
  };
}

export function renderAnalysisMarkdown(analysis) {
  const lines = [
    `# ${analysis.human_event.title}`,
    "",
    `- Analysis Package: v${analysis.schema_version}`,
    `- Ingest ID: ${analysis.ingest_id}`,
    `- Source: ${analysis.source_ref}`,
    "",
    "## Human Event 摘要",
    ...analysis.human_event.summary_points.map((item) => `- ${item}`),
    "",
    "## 事实与不确定性",
    "### Facts",
    ...analysis.signal_analysis.facts.map((item) => `- ${item}`),
    "### Speculations",
    ...analysis.signal_analysis.speculations.map((item) => `- ${item}`),
    "### Unknowns",
    ...analysis.signal_analysis.unknowns.map((item) => `- ${item}`),
    "",
    "## 候选对象",
    ...renderCandidates("Topic", analysis.topic_candidates),
    ...renderCandidates("Task", analysis.task_candidates),
    ...renderCandidates("Method", analysis.method_candidates),
    ...renderCandidates("Dictionary", analysis.dictionary_candidates),
    ...renderCandidates("Person", analysis.person_candidates),
    ...renderCandidates("Memory", analysis.memory_proposals),
    "",
    "## 未确定项",
    ...analysis.uncertainties.map((item) => `- ${item}`),
    ""
  ];
  return lines.join("\n");
}

function renderCandidates(label, candidates) {
  if (!candidates.length) return [];
  return [
    `### ${label} candidates`,
    ...candidates.flatMap((item) => [
      `- ${item.title || item.statement || "未命名"}${item.summary ? `：${item.summary}` : ""}`,
      ...(item.source_refs || []).map((source) => `  - source: ${source}`),
      ...(item.evidence || []).map((entry) => `  - evidence: ${entry.source_ref}:${entry.line_start}-${entry.line_end} ${entry.excerpt_redacted}`),
      ...(item.evidence_status === "missing" ? ["  - evidence: missing"] : [])
    ]),
    ""
  ];
}

function normalizeCandidates(value, type) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "string") {
      return { title: item.trim(), statement: item.trim(), summary: "", status: "candidate", candidate_status: "candidate", source_refs: [], evidence: [], evidence_status: "missing" };
    }
    const candidate = item && typeof item === "object" ? item : {};
    const evidence = normalizeEvidence(candidate.evidence);
    return {
      ...candidate,
      title: candidateTitle(candidate, type),
      statement: String(candidate.statement || "").trim(),
      summary: String(candidate.summary || "").trim(),
      content: String(candidate.content || "").trim(),
      status: String(candidate.candidate_status || (type === "task" ? "candidate" : candidate.status) || "candidate").trim(),
      candidate_status: String(candidate.candidate_status || "candidate").trim(),
      source_status: type === "task" ? String(candidate.source_status || candidate.status || "").trim() : "",
      owner: type === "task" ? String(candidate.owner || candidate.assignee || "").trim() : String(candidate.owner || "").trim(),
      fact_status: String(candidate.fact_status || "candidate").trim(),
      confidence: candidate.confidence == null ? null : String(candidate.confidence),
      source_refs: normalizeList(candidate.source_refs),
      evidence_quotes: normalizeList(candidate.evidence_quotes),
      evidence,
      evidence_status: evidence.length ? "verified" : "missing",
      ...(type === "memory" ? { target: normalizeMemoryTarget(candidate.target) } : {})
    };
  });
}

function candidateTitle(candidate, type) {
  const aliases = {
    person: candidate.name,
    dictionary: candidate.term,
    memory: candidate.proposal || candidate.statement,
    decision: candidate.decision || candidate.statement
  };
  return String(candidate.title || aliases[type] || candidate.statement || "").trim();
}

function normalizeEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    source_ref: String(item?.source_ref || "").trim(),
    line_start: Number(item?.line_start || 0),
    line_end: Number(item?.line_end || 0),
    excerpt_redacted: String(item?.excerpt_redacted || "").trim().slice(0, 200),
    verification: String(item?.verification || "").trim()
  })).filter((item) => item.source_ref && item.line_start > 0 && item.line_end >= item.line_start && ["exact", "whitespace_normalized"].includes(item.verification));
}

function normalizeMemoryTarget(value) {
  const target = String(value || "").trim();
  return target.startsWith("10-memory/") ? target : "10-memory/candidates.md";
}

function normalizeNullable(value) {
  const text = String(value || "").trim();
  return text || null;
}

function normalizeList(value, max = Infinity) {
  const values = Array.isArray(value) ? value : (value == null || value === "" ? [] : [value]);
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, max);
}
