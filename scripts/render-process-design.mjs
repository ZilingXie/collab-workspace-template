#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getWorkspaceRoot, writeJsonAtomic } from "./card-v1-lib.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = getWorkspaceRoot(scriptDirectory);
const sourcePath = path.join(workspaceRoot, "03-decisions", "project-process-design.md");
const outputPath = path.join(workspaceRoot, "07-state", "process-design.json");
const source = await fs.readFile(sourcePath, "utf8");

const markerPattern = /<!--\s*process:([^|]+)\|([^|]+)\|([^\s]+)\s*-->\s*\n##\s+([^\n]+)\n([\s\S]*?)(?=\n<!--\s*process:|$)/g;
const sections = [];
let match;
while ((match = markerPattern.exec(source))) {
  sections.push({
    id: match[1].trim(),
    kind: match[2].trim(),
    status: match[3].trim(),
    title: match[4].trim(),
    body_markdown: match[5].trim()
  });
}

if (!sections.length) throw new Error("project-process-design.md contains no process sections");
if (new Set(sections.map((section) => section.id)).size !== sections.length) throw new Error("process section ids must be unique");

const flow = extractFlow(sections.find((section) => section.id === "overview")?.body_markdown || "");
const document = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source_path: "03-decisions/project-process-design.md",
  title: "用户手册",
  description: "材料如何进入共享 Workspace，并形成交流记录、Personal Card、项目议题、Task 与可审计执行。",
  flow,
  sections
};

await writeJsonAtomic(outputPath, document);
console.log(JSON.stringify({ ok: true, output: "07-state/process-design.json", sections: sections.length, flow_steps: flow.length }));

function extractFlow(markdown) {
  const block = String(markdown).match(/```(?:text)?\s*\n([\s\S]*?)```/i)?.[1] || "";
  return block.split(/\r?\n/)
    .map((line) => line.replace(/^\s*→\s*/, "").trim())
    .filter(Boolean);
}
