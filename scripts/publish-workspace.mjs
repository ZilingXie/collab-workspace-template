#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getWorkspaceRoot,
  readJson,
  writeJsonAtomic
} from "./card-v1-lib.mjs";

const scriptDirectory = path.dirname(new URL(import.meta.url).pathname);
const workspaceRoot = getWorkspaceRoot(scriptDirectory);
const publicRoot = path.join(workspaceRoot, "public-data");
const versionsRoot = path.join(publicRoot, "versions");
const manifestPath = path.join(publicRoot, "manifest.json");
const lockPath = path.join(publicRoot, ".publish.lock");
const reason = argument("--reason") || "manual";

await withPublishLock(async () => {
  const source = await loadSourceData();
  const datasets = await buildPublicDatasets(source);
  const payload = {
    project: datasets.project,
    cards: datasets.cards,
    tasks: datasets.tasks,
    files: datasets.files,
    people: datasets.people,
    process: datasets.process,
    memory: datasets.memory
  };
  const dataVersion = hashPayload(payload).slice(0, 24);
  const currentManifest = await readJson(manifestPath, null);

  if (currentManifest?.data_version === dataVersion) {
    await pruneVersions(`data-${dataVersion}`);
    console.log(JSON.stringify({
      ok: true,
      changed: false,
      data_version: dataVersion,
      reason
    }));
    return;
  }

  const versionName = `data-${dataVersion}`;
  const versionRoot = path.join(versionsRoot, versionName);
  await fs.mkdir(versionRoot, { recursive: true, mode: 0o2775 });
  await writeJsonAtomic(path.join(versionRoot, "project.json"), datasets.project);
  await writeJsonAtomic(path.join(versionRoot, "cards.json"), datasets.cards);
  await writeJsonAtomic(path.join(versionRoot, "tasks.json"), datasets.tasks);
  await writeJsonAtomic(path.join(versionRoot, "files.json"), datasets.files);
  await writeJsonAtomic(path.join(versionRoot, "people.json"), datasets.people);
  await writeJsonAtomic(path.join(versionRoot, "process.json"), datasets.process);
  await writeJsonAtomic(path.join(versionRoot, "memory.json"), datasets.memory);

  const manifest = {
    schema_version: 1,
    data_version: dataVersion,
    generated_at: new Date().toISOString(),
    reason,
    workspace: "collab_workspace",
    datasets: {
      project: `public-data/versions/${versionName}/project.json`,
      cards: `public-data/versions/${versionName}/cards.json`,
      tasks: `public-data/versions/${versionName}/tasks.json`,
      files: `public-data/versions/${versionName}/files.json`,
      people: `public-data/versions/${versionName}/people.json`,
      process: `public-data/versions/${versionName}/process.json`,
      memory: `public-data/versions/${versionName}/memory.json`
    }
  };
  await writeJsonAtomic(manifestPath, manifest);
  await pruneVersions(versionName);
  console.log(JSON.stringify({
    ok: true,
    changed: true,
    data_version: dataVersion,
    version: versionName,
    reason
  }));
});

async function loadSourceData() {
  return {
    project: await readJson(path.join(workspaceRoot, "workspace.config.json"), defaultProject()),
    cards: await readJson(path.join(workspaceRoot, "08-cards", "card_index.json"), emptyCards()),
    tasks: await readJson(path.join(workspaceRoot, "09-tasks", "task_index.json"), { schema_version: 1, tasks: [] }),
    files: await readJson(path.join(workspaceRoot, "07-state", "file_manifest.json"), { schema_version: 1, files: [], directories: [] }),
    process: await readJson(path.join(workspaceRoot, "07-state", "process-design.json"), { schema_version: 1, sections: [], flow: [] }),
    memory: await readJson(path.join(workspaceRoot, "10-memory", "memory-index.json"), { schema_version: 1, records: [] })
  };
}

async function buildPublicDatasets(source) {
  const project = sanitizeProject(source.project);
  const cards = await sanitizeCardIndex(source.cards);
  const tasks = {
    ...sanitizeRecord(source.tasks),
    tasks: (source.tasks.tasks || []).map((task) => sanitizeRecord(task))
  };
  const files = {
    ...sanitizeRecord(source.files),
    files: (source.files.files || []).map((file) => sanitizeRecord(file)),
    directories: (source.files.directories || []).map((directory) => sanitizeRecord(directory)),
    readme_text: await readWorkspaceReadme()
  };
  const profiles = (project.participants || []).map((person) => ({
    ...person,
    name: person.name === "Project Hermes" ? "Hermes" : person.name,
    display_name: person.name
  }));
  const edges = (project.people_graph?.edges || []).map((edge) => ({
    ...edge,
    source: edge.source === "Project Hermes" ? "Hermes" : edge.source,
    target: edge.target === "Project Hermes" ? "Hermes" : edge.target
  }));
  const people = {
    schema_version: 1,
    profiles,
    edges,
    project_node: { name: project.title, id: "project" }
  };
  const process = sanitizeRecord(source.process);
  const memory = {
    ...sanitizeRecord(source.memory),
    records: (source.memory.records || []).map((record) => sanitizeRecord(record))
  };
  delete project.people_graph;
  return { project, cards, tasks, files, people, process, memory };
}

async function sanitizeCardIndex(index) {
  const result = sanitizeRecord(index);
  result.events = await Promise.all((index.events || []).map((event) => sanitizeRecord(event)));
  result.cards = (index.cards || []).map((card) => sanitizeCard(card));
  result.card_revisions = (index.card_revisions || []).map((card) => sanitizeCard(card));
  result.human_events = (index.human_events || []).map((event) => sanitizeRecord(event));
  result.topics = (index.topics || []).map((topic) => sanitizeRecord(topic));
  result.tasks = (index.tasks || []).map((task) => sanitizeRecord(task));
  result.briefings = await Promise.all((index.briefings || []).map((briefing) => sanitizeBriefing(briefing)));
  return result;
}

function sanitizeCard(card) {
  const result = sanitizeRecord(card);
  for (const field of ["card_path", "content_path", "event_path", "topic_path", "task_path", "audit_path"]) {
    if (field in result) result[field] = publicReference(result[field]);
  }
  for (const field of ["card_url", "content_url", "task_card_url", "html_card_url"]) {
    if (field in result) result[field] = publicUrl(result[field]);
  }
  result.source_refs = publicReferences(result.source_refs);
  return result;
}

async function sanitizeBriefing(briefing) {
  const result = sanitizeRecord(briefing);
  for (const field of ["json_path", "briefing_path", "draft_path", "markdown_path", "final_path"]) {
    if (field in result) result[field] = publicReference(result[field]);
  }
  for (const field of ["json_url", "markdown_url", "final_url"]) {
    if (field in result) result[field] = publicUrl(result[field]);
  }
  const markdownPath = briefing.final_path || briefing.markdown_path || briefing.draft_path;
  result.public_markdown = markdownPath ? await readPublishedText(markdownPath) : "";
  return result;
}

function sanitizeProject(project) {
  return {
    schema_version: project.schema_version || 1,
    title: String(project.title || "项目 Workspace"),
    status: String(project.status || "运行中"),
    goal: String(project.goal || ""),
    creator: sanitizeRecord(project.creator || {}),
    owner: sanitizeRecord(project.owner || {}),
    participants: (project.participants || []).map((person) => sanitizeRecord(person)),
    tabs: (project.tabs || []).map((tab) => sanitizeRecord(tab)),
    config: (project.config || []).map((item) => sanitizeRecord(item)),
    people_graph: sanitizeRecord(project.people_graph || {}),
    refresh_interval_ms: Number(project.refresh_interval_ms) || 30000,
    timezone: String(project.timezone || "Asia/Shanghai")
  };
}

function sanitizeRecord(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeRecord(item));
  if (typeof value === "string") return redactPublicText(value);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "generated_at") continue;
    if (key === "absolute_path" || key === "filesystem_path") continue;
    if (key === "source_refs") {
      result[key] = publicReferences(item);
      continue;
    }
    if (key === "source_ref") {
      result[key] = publicReference(item);
      continue;
    }
    if (key === "raw_source_path" || key === "analysis_path") {
      result[key] = "";
      continue;
    }
    if (key.endsWith("_path") || key === "path") {
      result[key] = typeof item === "string" ? publicReference(item) : sanitizeRecord(item);
      continue;
    }
    if (key.endsWith("_url") || key === "url") {
      result[key] = typeof item === "string" ? publicUrl(item) : sanitizeRecord(item);
      continue;
    }
    result[key] = sanitizeRecord(item);
  }
  return result;
}

function redactPublicText(value) {
  return String(value || "")
    .replace(/(?:\/home\/ubuntu|\/workspace)\/[^\s`"'<>)]*/g, "[内部路径]")
    .replace(/(?:01-raw|02-notes\/intakes|08-cards\/(?:inbox|processing|review|quarantine|human-events)|09-tasks\/tasks)\/[^\s`"'<>)]*/g, "[内部材料]")
    .replace(/(?:AGENTRELAY_[A-Z_]+|(?:token|webhook|password)\s*[:=]\s*)[^\s`"'<>)]*/gi, "[已脱敏]");
}

function publicReferences(values) {
  return (Array.isArray(values) ? values : []).map(publicReference).filter(Boolean);
}

function publicBaseUrl() {
  return String(process.env.COLLAB_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
}

function publicReference(value) {
  const reference = String(value || "").trim();
  if (!reference) return "";
  if (reference.startsWith("/collaborate/")) return reference;
  const base = publicBaseUrl();
  if (base && reference.startsWith(`${base}/`)) return reference;
  const allowed = [
    "README.md",
    "02-notes/wiki/",
    "03-decisions/",
    "04-reports/",
    "05-agent-outputs/",
    "06-pdca/",
    "07-state/",
    "08-cards/cards/",
    "08-cards/contents/",
    "10-memory/"
  ];
  return allowed.some((prefix) => reference === prefix || reference.startsWith(prefix)) ? reference : "";
}

function publicUrl(value) {
  const reference = String(value || "").trim();
  if (!reference) return null;
  if (reference.startsWith("/collaborate/")) return reference;
  const base = publicBaseUrl();
  if (base && reference.startsWith(`${base}/`)) return reference;
  const safe = publicReference(reference);
  return safe ? `/collaborate/${safe.split("/").map(encodeURIComponent).join("/")}` : null;
}

async function readPublishedText(relativePath) {
  const safePath = publicReference(relativePath);
  if (!safePath) return "";
  try {
    return redactPublicText(await fs.readFile(path.join(workspaceRoot, safePath), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function readWorkspaceReadme() {
  try {
    return redactPublicText(await fs.readFile(path.join(workspaceRoot, "README.md"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function pruneVersions(currentVersion) {
  const entries = await fs.readdir(versionsRoot, { withFileTypes: true }).catch(() => []);
  const versions = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("data-"))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const version of versions) {
    if (version !== currentVersion) await fs.rm(path.join(versionsRoot, version), { recursive: true, force: true });
  }
}

async function withPublishLock(callback) {
  await fs.mkdir(publicRoot, { recursive: true, mode: 0o2775 });
  try {
    await fs.mkdir(lockPath, { recursive: false });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Workspace publish already running: ${lockPath}`);
    throw error;
  }
  try {
    await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, reason, at: new Date().toISOString() }) + "\n");
    await callback();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

function hashPayload(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function emptyCards() {
  return { schema_version: 3, events: [], cards: [], card_revisions: [], human_events: [], topics: [], tasks: [], briefings: [] };
}

function defaultProject() {
  return { schema_version: 1, title: "项目 Workspace", status: "未配置", goal: "", participants: [], tabs: [], config: [], people_graph: {} };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : String(process.argv[index + 1] || "");
}
