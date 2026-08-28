#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { getWorkspaceRoot, readJson } from "./card-v1-lib.mjs";
import { createMemoryRecord, upsertMethodRecord, appendMemoryAudit } from "./memory-registry.mjs";

const scriptDirectory = path.dirname(new URL(import.meta.url).pathname);
const workspaceRoot = getWorkspaceRoot(scriptDirectory);
const eventId = argument("--human-event-id");
const renderOnly = process.argv.includes("--render-only");
const reconcileEvents = process.argv.includes("--reconcile-events");

if (!renderOnly && eventId) await reconcileHumanEvent(eventId);
if (!renderOnly && reconcileEvents) await reconcileAllHumanEvents();
await import(`./render-memory-index.mjs?reconcile=${Date.now()}`);

async function reconcileHumanEvent(humanEventId) {
  const eventPath = path.join(workspaceRoot, "08-cards", "human-events", "records", humanEventId, "event.json");
  const event = await readJson(eventPath, null);
  if (!event) throw new Error(`Human Event not found: ${humanEventId}`);
  if (event.status !== "materialized" || event.summary_status !== "final") return;
  if ((!Array.isArray(event.memory_entries) || !event.memory_entries.length)
    && (!Array.isArray(event.method_entries) || !event.method_entries.length)) return;
  // Only an explicit memory_entries array is eligible. Summaries and candidate
  // Topics are evidence for humans, not implicit Memory write instructions.
  for (const entry of Array.isArray(event.memory_entries) ? event.memory_entries : []) {
    if (entry.status !== "confirmed" || !entry.statement || !entry.source_refs?.length) {
      await appendMemoryAudit(workspaceRoot, { type: "rejected_entry", human_event_id: humanEventId, reason: "entry_not_explicitly_confirmed" });
      continue;
    }
    try {
      await createMemoryRecord(workspaceRoot, {
        ...entry,
        memory_type: entry.memory_type || "consensus",
        status: "active",
        fact_status: "confirmed",
        evidence_type: entry.evidence_type || "confirmed_human_event",
        source_refs: entry.source_refs,
        body: entry.statement,
        human_event_ids: [humanEventId]
      });
    } catch (error) {
      await appendMemoryAudit(workspaceRoot, {
        type: "rejected_entry",
        human_event_id: humanEventId,
        memory_id: entry.memory_id || null,
        reason: error.code || String(error.message || error).slice(0, 500)
      });
    }
  }
  for (const entry of Array.isArray(event.method_entries) ? event.method_entries : []) {
    if (entry.status !== "confirmed" || entry.fact_status !== "confirmed" || !entry.title || !entry.summary || !entry.source_refs?.length) {
      await appendMemoryAudit(workspaceRoot, { type: "rejected_method", human_event_id: humanEventId, reason: "method_not_explicitly_confirmed" });
      continue;
    }
    try {
      await upsertMethodRecord(workspaceRoot, {
        ...entry,
        memory_type: "method",
        status: "active",
        fact_status: "confirmed",
        evidence_type: entry.evidence_type || "confirmed_human_event",
        source_refs: entry.source_refs,
        body: entry.summary,
        human_event_ids: [humanEventId]
      });
    } catch (error) {
      await appendMemoryAudit(workspaceRoot, {
        type: "rejected_method",
        human_event_id: humanEventId,
        memory_id: entry.memory_id || null,
        reason: error.code || String(error.message || error).slice(0, 500)
      });
    }
  }
}

async function reconcileAllHumanEvents() {
  const recordsRoot = path.join(workspaceRoot, "08-cards", "human-events", "records");
  let entries = [];
  try { entries = await fs.readdir(recordsRoot, { withFileTypes: true }); } catch { return; }
  for (const entry of entries.filter((item) => item.isDirectory())) await reconcileHumanEvent(entry.name);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : String(process.argv[index + 1] || "");
}
