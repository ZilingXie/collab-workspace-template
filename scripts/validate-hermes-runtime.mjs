#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultWorkspaceRoot = path.resolve(process.env.COLLAB_WORKSPACE || path.join(scriptDirectory, ".."));

export async function validateRuntimeWorkspace(workspaceRoot = defaultWorkspaceRoot) {
  const errors = [];
  const required = [
    "03-decisions/hermes-runtime/README.md",
    "03-decisions/hermes-policies/README.md",
    "03-decisions/hermes-policies/prohibited-actions.md",
    "03-decisions/hermes-policies/information-disclosure.md",
    "03-decisions/hermes-policies/workspace-boundary.md",
    "03-decisions/hermes-policies/l3-actions.md",
    "03-decisions/hermes-actions/README.md",
    "03-decisions/hermes-actions/general-project-action.md",
    "03-decisions/hermes-actions/ingest-conversation.md",
    "03-decisions/hermes-actions/task-assignment.md",
    "03-decisions/hermes-actions/fanout-task-creation.md",
    "03-decisions/hermes-actions/task-result-acceptance.md",
    "03-decisions/hermes-actions/meeting-briefing.md",
    "03-decisions/hermes-actions/quoted-message-explanation.md",
    "03-decisions/hermes-actions/human-event-convergence.md",
    "03-decisions/hermes-actions/personal-card-ingest.md",
    "03-decisions/hermes-actions/project-question.md",
    "03-decisions/hermes-actions/project-status-query.md",
    "03-decisions/hermes-actions/memory-write-and-correction.md",
    "03-decisions/hermes-actions/identity-resolution.md"
  ];
  for (const relative of required) {
    if (!(await exists(path.join(workspaceRoot, relative)))) errors.push(`missing: ${relative}`);
  }
  const guides = required.filter((relative) => relative.includes("/hermes-actions/") && !relative.endsWith("/README.md"));
  const actionIds = new Set();
  const entryTools = new Map();
  for (const relative of guides) {
    const file = path.join(workspaceRoot, relative);
    if (!(await exists(file))) continue;
    const text = await fs.readFile(file, "utf8");
    const actionId = text.match(/^action_id:\s*([^\s]+)\s*$/m)?.[1];
    if (!actionId) errors.push(`missing action_id: ${relative}`);
    else if (actionIds.has(actionId)) errors.push(`duplicate action_id: ${actionId}`);
    else actionIds.add(actionId);
    const frontmatter = parseFrontmatter(text);
    const entryTool = scalarField(frontmatter, "entry_tool");
    const modelAllowedTools = listField(frontmatter, "model_allowed_tools");
    const internalTools = listField(frontmatter, "internal_tools");
    if (entryTool) {
      if (entryTools.has(entryTool)) errors.push(`duplicate entry_tool ${entryTool}: ${entryTools.get(entryTool)}, ${relative}`);
      else entryTools.set(entryTool, relative);
      if (!modelAllowedTools.includes(entryTool)) errors.push(`entry_tool not model_allowed: ${entryTool} in ${relative}`);
    }
    for (const tool of internalTools) {
      if (modelAllowedTools.includes(tool)) errors.push(`internal tool is model_allowed: ${tool} in ${relative}`);
    }
    const refs = [...text.matchAll(/^\s+-\s+([^\s]+)\s*$/gm)].map((match) => match[1]);
    for (const ref of refs.filter((item) => item.includes("/") && !item.startsWith("http"))) {
      if (!(await exists(path.join(workspaceRoot, ref)))) errors.push(`missing source_ref ${ref} in ${relative}`);
    }
  }
  const actionIndex = await fs.readFile(path.join(workspaceRoot, "03-decisions/hermes-actions/README.md"), "utf8");
  const indexedActionIds = new Set([...actionIndex.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((match) => match[1]));
  for (const actionId of actionIds) if (!indexedActionIds.has(actionId)) errors.push(`action missing from index: ${actionId}`);
  for (const actionId of indexedActionIds) if (!actionIds.has(actionId)) errors.push(`index action missing guide: ${actionId}`);

  const hermesAgentRoot = process.env.HERMES_AGENT_ROOT || path.join(os.homedir(), ".hermes", "hermes-agent");
  const toolsetsPath = path.join(hermesAgentRoot, "toolsets.py");
  if (await exists(toolsetsPath)) {
    const toolsets = await fs.readFile(toolsetsPath, "utf8");
    for (const [entryTool, relative] of entryTools) {
      if (!new RegExp(`^[\\t ]*[\"']${escapeRegex(entryTool)}[\"']`, "m").test(toolsets)) {
        errors.push(`entry_tool missing from model toolset: ${entryTool} in ${relative}`);
      }
      for (const internalTool of listField(parseFrontmatter(await fs.readFile(path.join(workspaceRoot, relative), "utf8")), "internal_tools")) {
        if (new RegExp(`^[\\t ]*[\"']${escapeRegex(internalTool)}[\"']`, "m").test(toolsets)) {
          errors.push(`internal tool exposed in model toolset: ${internalTool}`);
        }
      }
    }
  }
  return errors;
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return "";
  const end = text.indexOf("\n---", 4);
  return end >= 0 ? text.slice(4, end) : "";
}

function scalarField(frontmatter, key) {
  return frontmatter.match(new RegExp(`^${escapeRegex(key)}:\\s*([^\\s#]+)\\s*$`, "m"))?.[1] || "";
}

function listField(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${escapeRegex(key)}:\\s*\\n((?:[ \\t]+- [^\\n]+\\n?)*)`, "m"));
  return match ? [...match[1].matchAll(/^[ \t]+-\s+([^\s#]+)\s*$/gm)].map((item) => item[1]) : [];
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && process.argv[1].endsWith("validate-hermes-runtime.mjs")) {
  const errors = await validateRuntimeWorkspace();
  if (errors.length) {
    console.error(JSON.stringify({ ok: false, errors }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true, action_guides: 13, policy_files: 5 }));
  }
}
