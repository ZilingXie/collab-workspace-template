import fs from "node:fs/promises";
import path from "node:path";
import { appendJsonLine, getWorkspaceRoot, readJson, writeJsonAtomic } from "./card-v1-lib.mjs";

const ALLOWED_ACTIONS = new Set([
  "task_assignment",
  "meeting_briefing",
  "quoted_message_explanation",
  "disagreement_analysis",
  "personal_card_generation",
  "project_question",
  "term_resolution"
]);

export async function recordMemoryUsage(workspaceRoot, input) {
  const action = String(input?.action || "").trim();
  if (!ALLOWED_ACTIONS.has(action)) throw new Error(`Unsupported memory usage action: ${action}`);
  const entry = {
    usage_id: String(input.usage_id || "").trim(),
    action,
    requester: String(input.requester || "").trim(),
    subject_person: String(input.subject_person || "").trim(),
    participants: unique(input.participants),
    memory_ids: unique(input.memory_ids || input.memory_refs),
    memory_paths: unique(input.memory_paths),
    dynamic_refs: unique(input.dynamic_refs),
    outcome_ref: String(input.outcome_ref || "").trim() || null,
    used_at: input.used_at || new Date().toISOString()
  };
  if (!entry.usage_id) throw new Error("Memory usage requires usage_id");
  const auditPath = path.join(workspaceRoot, ".hermes", "audit", "memory-usage.jsonl");
  await appendJsonLine(auditPath, entry);
  await renderMemoryUsageIndex(workspaceRoot);
  return entry;
}

export async function renderMemoryUsageIndex(workspaceRoot) {
  const auditPath = path.join(workspaceRoot, ".hermes", "audit", "memory-usage.jsonl");
  const indexPath = path.join(workspaceRoot, "10-memory", "memory-usage-index.json");
  let lines = [];
  try { lines = (await fs.readFile(auditPath, "utf8")).split(/\r?\n/).filter(Boolean); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const entries = lines.map((line) => JSON.parse(line));
  const byMemory = new Map();
  for (const entry of entries) {
    for (const memoryId of entry.memory_ids || []) {
      const current = byMemory.get(memoryId) || { memory_id: memoryId, usage_count: 0, actions: [], last_used_at: null, outcome_refs: [] };
      current.usage_count += 1;
      current.actions = unique([...current.actions, entry.action]);
      current.last_used_at = !current.last_used_at || String(entry.used_at).localeCompare(current.last_used_at) > 0 ? entry.used_at : current.last_used_at;
      if (entry.outcome_ref) current.outcome_refs = unique([...current.outcome_refs, entry.outcome_ref]);
      byMemory.set(memoryId, current);
    }
  }
  await writeJsonAtomic(indexPath, {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source: "memory-usage-audit",
    usage_count: entries.length,
    memories: [...byMemory.values()].sort((a, b) => a.memory_id.localeCompare(b.memory_id))
  });
  return indexPath;
}

function unique(values) { return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))]; }

if (process.argv[1] && process.argv[1].endsWith("memory-usage.mjs")) {
  const workspaceRoot = getWorkspaceRoot(path.dirname(process.argv[1]));
  await renderMemoryUsageIndex(workspaceRoot);
  console.log(JSON.stringify({ ok: true, output: "10-memory/memory-usage-index.json" }));
}
