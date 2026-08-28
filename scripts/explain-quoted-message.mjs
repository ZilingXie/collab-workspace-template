#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { buildMemoryContext } from "./memory-context.mjs";
import { recordMemoryUsage } from "./memory-usage.mjs";
import { getWorkspaceRoot, readJson } from "./card-v1-lib.mjs";

const scriptDirectory = path.dirname(new URL(import.meta.url).pathname);

export async function explainQuotedMessage({
  workspaceRoot,
  quotedText,
  requester = "Zac",
  speaker = "Vivi",
  humanEventId = "",
  topicId = ""
}) {
  if (!String(quotedText || "").trim()) throw new Error("quotedText is required");
  const context = await buildMemoryContext({
    workspaceRoot,
    action: "quoted_message_explanation",
    requester,
    subjectPerson: speaker,
    participants: [requester, speaker],
    humanEventId,
    topicId
  });
  const dictionary = context.memory.filter((item) => item.memory_type === "dictionary");
  const terms = findTerms(quotedText, dictionary);
  const dynamic = await readDynamicContext(workspaceRoot, { humanEventId, topicId });
  const missingDynamicContext = dynamic.missing.map((item) => item.message);
  const memoryContext = context.memory
    .filter((item) => ["consensus", "project_context", "project_identity"].includes(item.memory_type))
    .map((item) => ({
      memory_id: item.memory_id,
      path: item.path,
      excerpt: compact(item.content, 500)
    }));
  const output = {
    schema_version: 1,
    explanation_id: `explanation-${Date.now().toString(36)}`,
    created_at: new Date().toISOString(),
    requester,
    speaker,
    quoted_text: quotedText,
    simple_summary: buildNeutralSummary(quotedText, speaker),
    context: memoryContext,
    dynamic_context: dynamic.context,
    key_concepts: terms,
    ambiguity: buildAmbiguity({ speaker, dynamicContext: dynamic.context, missingDynamicContext }),
    clarification_question: `请 ${speaker} 确认：这里的表达是指当前项目语境中的具体判断，还是还有未写出的其他前提？`,
    memory_usage_id: context.usage_id,
    dynamic_refs: dynamic.refs,
    missing_dynamic_context: missingDynamicContext,
    source_refs: [
      "10-memory/retrieval-rules.md",
      ...context.memory.map((item) => item.path),
      ...dynamic.refs
    ]
  };
  return { output, context };
}

export async function readDynamicContext(workspaceRoot, { humanEventId = "", topicId = "" } = {}) {
  const context = [];
  const refs = [];
  const missing = [];
  if (humanEventId) {
    const id = safeId(humanEventId, "human_event_id");
    const relativePath = `08-cards/human-events/records/${id}/event.json`;
    const event = await readOptionalJson(workspaceRoot, relativePath);
    if (event) {
      refs.push(relativePath);
      context.push({
        type: "human_event",
        id,
        title: compact(event.title, 240),
        summary: compact(event.summary || event.key_points?.join("；"), 700),
        occurred_at: event.occurred_at || null,
        source_refs: compactRefs(event.source_refs)
      });
      const index = await readOptionalJson(workspaceRoot, "08-cards/card_index.json");
      if (index) {
        refs.push("08-cards/card_index.json");
        const cards = (index.cards || [])
          .filter((card) => card.lifecycle_status === "accepted")
          .filter((card) => card.human_event_id === id || card.event_id === id)
          .sort(byDateDesc)
          .slice(0, 3);
        for (const card of cards) {
          context.push({
            type: "personal_card",
            id: card.card_id,
            author: card.author || "",
            title: compact(card.title, 200),
            summary: compact(card.summary || card.key_points?.join("；"), 500),
            source_refs: compactRefs(card.source_refs)
          });
        }
      }
    } else {
      missing.push({
        type: "human_event",
        id,
        message: `未找到显式指定的 Human Event：${id}`
      });
    }
  }
  if (topicId) {
    const id = safeId(topicId, "topic_id");
    const relativePath = `08-cards/topics/${id}/topic.json`;
    const topic = await readOptionalJson(workspaceRoot, relativePath);
    if (topic) {
      refs.push(relativePath);
      context.push({
        type: "topic",
        id,
        title: compact(topic.title, 240),
        summary: compact(topic.current_summary || topic.summary || topic.key_points?.join("；"), 700),
        human_event_ids: compactRefs(topic.human_event_ids),
        source_refs: compactRefs(topic.source_refs)
      });
      const index = await readOptionalJson(workspaceRoot, "08-cards/card_index.json");
      if (index) {
        if (!refs.includes("08-cards/card_index.json")) refs.push("08-cards/card_index.json");
        const cards = (index.cards || [])
          .filter((card) => card.lifecycle_status === "accepted" && card.topic_id === id)
          .sort(byDateDesc)
          .slice(0, 3);
        for (const card of cards) {
          context.push({
            type: "personal_card",
            id: card.card_id,
            author: card.author || "",
            title: compact(card.title, 200),
            summary: compact(card.summary || card.key_points?.join("；"), 500),
            source_refs: compactRefs(card.source_refs)
          });
        }
      }
    } else {
      missing.push({
        type: "topic",
        id,
        message: `未找到显式指定的 Topic：${id}`
      });
    }
  }
  return { context, refs: [...new Set(refs)], missing };
}

async function main() {
  const workspaceRoot = getWorkspaceRoot(scriptDirectory);
  const quotedText = argument("--text");
  const requester = argument("--requester") || "Zac";
  const speaker = argument("--speaker") || "Vivi";
  const humanEventId = argument("--human-event-id");
  const topicId = argument("--topic-id");
  if (!quotedText.trim()) {
    throw new Error("Usage: explain-quoted-message.mjs --text <quoted text> [--requester Zac] [--speaker Vivi] [--human-event-id ID] [--topic-id ID]");
  }
  const { output, context } = await explainQuotedMessage({
    workspaceRoot,
    quotedText,
    requester,
    speaker,
    humanEventId,
    topicId
  });
  const outputPath = path.join(workspaceRoot, "05-agent-outputs", "project-hermes", "quoted-explanations", `${output.explanation_id}.json`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o2775 });
  await fs.writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", { mode: 0o664 });
  await recordMemoryUsage(workspaceRoot, {
    usage_id: context.usage_id,
    action: context.action,
    requester,
    subject_person: speaker,
    participants: [requester, speaker],
    memory_ids: context.memory_refs,
    memory_paths: context.memory.map((item) => item.path),
    dynamic_refs: output.dynamic_refs,
    outcome_ref: path.relative(workspaceRoot, outputPath).split(path.sep).join("/")
  });
  console.log(JSON.stringify({
    ok: true,
    output: path.relative(workspaceRoot, outputPath).split(path.sep).join("/"),
    memory_usage_id: context.usage_id,
    dynamic_context_count: output.dynamic_context.length
  }, null, 2));
}

if (process.argv[1] && process.argv[1].endsWith("explain-quoted-message.mjs")) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}

function findTerms(text, records) {
  const lowered = String(text || "").toLocaleLowerCase();
  const matches = [];
  for (const record of records) {
    const terms = [
      ...String(record.content || "")
        .split(/\r?\n/)
        .map((line) => line.match(/^#{1,6}\s+(.+?)\s*$/)?.[1] || ""),
      ...extractTerms(text)
        .filter((term) => String(record.content || "").toLocaleLowerCase().includes(term.toLocaleLowerCase()))
    ]
      .map((value) => cleanTerm(value))
      .filter((value) => value.length >= 2 && !/^project dictionary$/i.test(value));
    const matchedTerms = [...new Set(terms.filter((term) => lowered.includes(term.toLocaleLowerCase())))];
    if (matchedTerms.length) {
      matches.push({
        memory_id: record.memory_id,
        path: record.path,
        matched_terms: matchedTerms,
        excerpt: compact(record.content, 700)
      });
    }
  }
  return matches;
}

function extractTerms(text) {
  return [...new Set(String(text || "").match(/[A-Za-z][A-Za-z0-9_-]{1,}|[\u4e00-\u9fff]{2,}/g) || [])];
}

function buildNeutralSummary(text, speaker) {
  return [
    `原话：${compact(text, 700)}`,
    `当前只对表达本身和已确认项目语境做解释，不把人物画像当作 ${speaker} 的额外发言。`
  ].join("\n");
}

function buildAmbiguity({ speaker, dynamicContext, missingDynamicContext }) {
  if (missingDynamicContext.length) {
    return `当前未能加载全部显式动态上下文；不能据此断定 ${speaker} 的真实意图。`;
  }
  if (!dynamicContext.length) {
    return `没有提供 Human Event 或 Topic ID；当前解释未根据相似文字猜测历史归属，也不能据此断定 ${speaker} 的真实意图。`;
  }
  return `以上解释结合了显式指定的 Human Event/Topic 和已确认 Memory；仍不能替 ${speaker} 补充原话中没有表达的结论。`;
}

async function readOptionalJson(workspaceRoot, relativePath) {
  try {
    return await readJson(path.join(workspaceRoot, relativePath));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function safeId(value, label) {
  const id = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`${label} contains unsupported characters`);
  return id;
}

function compactRefs(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 8) : [];
}

function byDateDesc(left, right) {
  return String(right.updated_at || right.submitted_at || right.occurred_at || "")
    .localeCompare(String(left.updated_at || left.submitted_at || left.occurred_at || ""));
}

function cleanTerm(value) {
  return String(value || "").replace(/^[-*\s]+/, "").replace(/[`*_：:]+$/, "").trim();
}

function compact(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
}
