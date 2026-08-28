#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractTitle,
  getWorkspaceRoot,
  parseFrontmatter,
  publicUrl,
  relativePath,
  unique,
  walkFiles,
  writeJsonAtomic
} from "./card-v1-lib.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = getWorkspaceRoot(scriptDirectory);
const outputPath = path.join(workspaceRoot, "07-state", "file_manifest.json");
const fileIndexPath = path.join(workspaceRoot, "07-state", "file_index.md");

const includeTargets = [
  "README.md",
  "02-notes/wiki",
  "03-decisions",
  "04-reports",
  "05-agent-outputs",
  "06-pdca",
  "07-state",
  "08-cards/cards",
  "08-cards/contents",
  "10-memory"
];

const visibleExtensions = new Set([
  ".md", ".markdown", ".txt", ".json", ".html", ".htm", ".pdf",
  ".doc", ".docx", ".csv", ".png", ".jpg", ".jpeg", ".webp", ".gif"
]);

const folderDescriptions = {
  "01-raw": "不可变的原始材料和入库来源。",
  "01-raw/intakes": "每次单附件入库的原始 TXT 与 manifest。",
  "02-notes": "可复用整理和项目 wiki。",
  "02-notes/intakes": "Analysis Package v2：一次入库的一份结构化分析。",
  "02-notes/wiki": "沉淀协议、概念和协作知识。",
  "03-decisions": "项目规则、协议和已确认决策。",
  "04-reports": "阶段性报告、复盘和验收记录。",
  "05-agent-outputs": "各参与 Agent 提交的项目产出。",
  "05-agent-outputs/project-hermes": "Project Hermes 的项目产出。",
  "05-agent-outputs/vivi-codex": "Vivi Codex 提交的项目产出。",
  "05-agent-outputs/zac-codex": "Zac Codex 提交的项目产出。",
  "05-agent-outputs/handoff-notes": "Agent 接手与交接记录。",
  "06-pdca": "失败样例、纠正和复测记录。",
  "07-state": "项目状态、人类索引和记忆候选。",
  "08-cards": "项目卡片与关联内容。",
  "08-cards/cards": "人类可消费的 Personal Card 与 Task Card。",
  "08-cards/contents": "卡片背后的完整上下文和回溯材料。",
  "10-memory": "Project Hermes 的文件式长期记忆与导航。",
  "10-memory/people": "人物明确角色、协作偏好和任务匹配边界。",
  "10-memory/people/facts": "按人物保存独立、明确且带来源的 person_fact 记录。",
  "10-memory/dictionary": "项目语境下的术语定义。",
  "10-memory/project": "项目身份与动态事实源导航。",
  "10-memory/consensus": "Human Event 已确认的共同共识。",
  "10-memory/corrections": "人类纠正 Hermes 后的记忆修订记录。",
  "10-memory/methods": "Human Event 收敛后确认的可复用方法。",
  "10-memory/methods/records": "正式 Method Memory 记录。"
};

const indexMetadata = await readFileIndex();
const files = [];

for (const target of includeTargets) {
  const absoluteTarget = path.join(workspaceRoot, target);
  const stats = await statOrNull(absoluteTarget);
  if (!stats) continue;
  const candidates = stats.isFile()
    ? [absoluteTarget]
    : await walkFiles(absoluteTarget, isVisibleFile);
  for (const filePath of candidates) {
    if (!isVisibleFile(filePath)) continue;
    files.push(await buildFileEntry(filePath));
  }
}

files.sort((a, b) => a.path.localeCompare(b.path));
const directories = buildDirectories(files);
const manifest = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  workspace: "collab_workspace",
  source: "filesystem",
  include_targets: includeTargets,
  file_count: files.length,
  directory_count: directories.length,
  directories,
  files
};

await writeJsonAtomic(outputPath, manifest);
console.log(JSON.stringify({ ok: true, output: relativePath(workspaceRoot, outputPath), files: files.length, directories: directories.length }));

function isVisibleFile(filePath) {
  const relative = relativePath(workspaceRoot, filePath);
  const parts = relative.split("/");
  if (parts.some((part) => part.startsWith("."))) return false;
  if (relative === "07-state/file_manifest.json") return false;
  if (relative.endsWith(".log") || relative.endsWith(".jsonl")) return false;
  if (path.extname(filePath).toLowerCase() === ".json"
    && !relative.startsWith("01-raw/intakes/")
    && !relative.startsWith("02-notes/intakes/")) return false;
  return visibleExtensions.has(path.extname(filePath).toLowerCase());
}

async function buildFileEntry(filePath) {
  const stats = await fs.stat(filePath);
  const relative = relativePath(workspaceRoot, filePath);
  const published = isExplicitlyPublished(relative);
  const indexed = indexMetadata.get(relative) || {};
  const extension = path.extname(filePath).toLowerCase();
  const isText = [".md", ".markdown", ".txt", ".html", ".htm", ".csv"].includes(extension);
  const text = isText ? await readText(filePath) : "";
  const parsed = parseFrontmatter(text);
  const title = indexed.title || extractTitle(parsed, path.basename(filePath));
  const extracted = extractSummary(parsed, extension);
  const summary = indexed.summary || extracted.summary || fallbackSummary(extension);
  const tags = unique([indexed.type || typeLabel(extension), indexed.source, indexed.status]).slice(0, 3);
  return {
    path: relative,
    url: published ? publicUrl(workspaceRoot, filePath) : null,
    name: path.basename(filePath),
    extension: extension.replace(/^\./, "") || "file",
    title,
    summary,
    summary_source: indexed.summary ? "file_index" : extracted.source,
    type: indexed.type || typeLabel(extension),
    source: indexed.source || "未标注",
    status: indexed.status || "当前",
    published,
    tags,
    size_bytes: stats.size,
    modified_at: stats.mtime.toISOString()
  };
}

function isExplicitlyPublished(relative) {
  return relative === "README.md"
    || relative.startsWith("02-notes/wiki/")
    || relative.startsWith("03-decisions/")
    || relative.startsWith("04-reports/")
    || relative.startsWith("05-agent-outputs/")
    || relative.startsWith("06-pdca/")
    || relative === "07-state/file_index.md"
    || relative.startsWith("08-cards/cards/")
    || relative.startsWith("08-cards/contents/")
    || relative.startsWith("10-memory/");
}

function extractSummary(parsed, extension) {
  const frontmatterSummary = parsed.data.summary || parsed.data.description || parsed.data.one_line || parsed.data.oneLine;
  if (frontmatterSummary) return { summary: compact(frontmatterSummary), source: "frontmatter" };
  if ([".html", ".htm"].includes(extension)) {
    const meta = parsed.body.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
      || parsed.body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
    if (meta) return { summary: compact(meta[1]), source: "content" };
  }
  const preferred = preferredSectionSummary(parsed.body);
  if (preferred) return { summary: compact(preferred), source: "content" };
  const body = parsed.body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidate = lines.find((line) => !/^#{1,6}\s/.test(line)
    && !/^[-*+]\s/.test(line)
    && !/^\d+[.)]\s/.test(line)
    && !/^\|/.test(line)
    && !/^>/.test(line)
    && !/^---+$/.test(line)
    && !/^(?:日期|时间|作者|维护者|目标路径|范围|状态|date|time|author|owner|scope|status)\s*[:：]/i.test(line));
  return candidate ? { summary: compact(candidate), source: "content" } : { summary: "", source: "fallback" };
}

function preferredSectionSummary(text) {
  const lines = String(text || "").split(/\r?\n/);
  const wanted = /^(?:一句话|一句话总结|摘要|概述|当前结论|结论|summary|overview|decision)$/i;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].trim().match(/^#{1,6}\s+(.+?)\s*$/);
    if (!heading || !wanted.test(heading[1].trim())) continue;
    const paragraph = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor].trim();
      if (/^#{1,6}\s+/.test(line)) break;
      if (!line || /^---+$/.test(line)) {
        if (paragraph.length) break;
        continue;
      }
      if (/^```/.test(line) || /^\|/.test(line)) break;
      paragraph.push(line.replace(/^>\s*/, ""));
    }
    if (paragraph.length) return paragraph.join(" ");
  }
  return "";
}

function compact(value, maxLength = 160) {
  const text = String(value || "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxLength ? text : text.slice(0, maxLength - 1) + "…";
}

function fallbackSummary(extension) {
  const labels = {
    ".pdf": "项目 PDF 文档。",
    ".doc": "项目 Word 文档。",
    ".docx": "项目 Word 文档。",
    ".csv": "项目表格数据。",
    ".png": "项目图片文件。",
    ".jpg": "项目图片文件。",
    ".jpeg": "项目图片文件。",
    ".webp": "项目图片文件。",
    ".gif": "项目图片文件。"
  };
  return labels[extension] || "项目文件。";
}

function typeLabel(extension) {
  const labels = {
    ".md": "Markdown",
    ".markdown": "Markdown",
    ".txt": "文本",
    ".html": "HTML",
    ".htm": "HTML",
    ".pdf": "PDF",
    ".doc": "Word",
    ".docx": "Word",
    ".csv": "CSV",
    ".png": "图片",
    ".jpg": "图片",
    ".jpeg": "图片",
    ".webp": "图片",
    ".gif": "图片"
  };
  return labels[extension] || "文件";
}

function buildDirectories(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const parts = entry.path.split("/").slice(0, -1);
    for (let index = 0; index < parts.length; index += 1) {
      const directory = parts.slice(0, index + 1).join("/");
      counts.set(directory, (counts.get(directory) || 0) + 1);
    }
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([directory, fileCount]) => ({
    path: directory,
    name: path.posix.basename(directory),
    description: folderDescriptions[directory] || `${path.posix.basename(directory)} 项目文件。`,
    file_count: fileCount
  }));
}

async function readFileIndex() {
  const metadata = new Map();
  const text = await readText(fileIndexPath);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
    if (cells.length < 6) continue;
    const pathMatch = cells[0].match(/^`([^`]+)`$/);
    if (!pathMatch || pathMatch[1].endsWith("/") || pathMatch[1].includes("`")) continue;
    metadata.set(pathMatch[1], {
      type: stripMarkdown(cells[1]),
      source: stripMarkdown(cells[2]),
      summary: stripMarkdown(cells[3]),
      status: stripMarkdown(cells[4])
    });
  }
  return metadata;
}

function stripMarkdown(value) {
  return String(value || "").replace(/[`*_]/g, "").trim();
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function statOrNull(filePath) {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
