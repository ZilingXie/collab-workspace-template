import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".html", ".htm"]);

export function getWorkspaceRoot(scriptDirectory) {
  return path.resolve(process.env.COLLAB_WORKSPACE || path.resolve(scriptDirectory, ".."));
}

export function randomId(prefix = "", bytes = 8) {
  return prefix + crypto.randomBytes(bytes).toString("hex");
}

export function normalizeSlug(value, fallback = "untitled") {
  const slug = String(value || "")
    .trim()
    .replace(/\.[^.]+$/, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || fallback;
}

export function scalar(value) {
  const text = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  return text;
}

export function parseFrontmatter(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { data: {}, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { data: {}, body: normalized };
  const raw = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\s+/, "");
  const data = {};
  let listKey = "";
  for (const line of raw.split("\n")) {
    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (listItem && listKey) {
      if (!Array.isArray(data[listKey])) data[listKey] = [];
      data[listKey].push(scalar(listItem[1]));
      continue;
    }
    const match = line.match(/^([^:#]+):\s*(.*)$/);
    if (!match) {
      listKey = "";
      continue;
    }
    const key = match[1].trim();
    const value = match[2].trim();
    if (!value) {
      data[key] = [];
      listKey = key;
    } else {
      data[key] = scalar(value);
      listKey = "";
    }
  }
  return { data, body };
}

export function arrayValue(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (!value) return [];
  return String(value)
    .split(/[,，、|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function firstMatchingLine(text, labels) {
  const escaped = labels.map((label) => label.replace(/[.*+?^$()|[\]\\]/g, "\\$&")).join("|");
  const match = String(text || "").match(new RegExp("^(?:" + escaped + ")\\s*[:：]\\s*(.+)$", "im"));
  return match ? match[1].trim() : "";
}

export function extractTitle(parsed, fallbackName) {
  if (parsed.data.title) return String(parsed.data.title).trim();
  const h1 = parsed.body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  const htmlTitle = parsed.body.match(/<(?:title|h1)[^>]*>([\s\S]*?)<\/(?:title|h1)>/i);
  if (htmlTitle) return htmlTitle[1].replace(/<[^>]+>/g, "").trim();
  const line = parsed.body.split(/\r?\n/).find((item) => item.trim() && !item.trim().startsWith("---"));
  return (line || fallbackName || "Untitled").replace(/^#+\s*/, "").trim().slice(0, 120);
}

export function extractDate(parsed, filename, stats) {
  const explicit = parsed.data.occurred_at
    || parsed.data.created_at
    || parsed.data.created
    || parsed.data.date
    || parsed.data.time
    || firstMatchingLine(parsed.body, ["发生时间", "时间", "日期", "occurred_at", "created_at", "date"]);
  if (explicit && !Number.isNaN(new Date(explicit).getTime())) return new Date(explicit);
  const dateInName = String(filename || "").match(/(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)/);
  if (dateInName) {
    const candidate = new Date(dateInName[1] + "-" + dateInName[2] + "-" + dateInName[3] + "T00:00:00+08:00");
    if (!Number.isNaN(candidate.getTime())) return candidate;
  }
  return stats.mtime;
}

export function excerpt(text, maxLength = 360) {
  const compact = String(text || "")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length <= maxLength ? compact : compact.slice(0, maxLength - 1) + "…";
}

export function normalizeHeading(value) {
  return String(value || "").trim().replace(/[#：:]/g, "").toLowerCase();
}

export function cleanListItem(value) {
  return String(value || "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .trim();
}

const SUMMARY_SECTION_HEADINGS = new Set([
  "卡片要点",
  "事实",
  "facts",
  "fact",
  "关键信息",
  "我的判断",
  "个人判断",
  "视角",
  "perspectives",
  "对候选 topic 的意见",
  "对候选 task 的意见",
  "展示反馈",
  "共识",
  "讨论结论",
  "当前结论",
  "结论",
  "最终结论",
  "下一步",
  "next",
  "next steps",
  "next step"
]);

export function normalizeSummaryPoints(value, maxItems = 3) {
  const values = Array.isArray(value) ? value : (value ? [value] : []);
  const limit = Math.max(1, Number(maxItems) || 3);
  const points = values
    .map((item) => cleanListItem(item).replace(/\s+/g, " ").trim())
    .map((item) => item.length > 280 ? item.slice(0, 277).trimEnd() + "..." : item)
    .filter((item) => item && !/^n\/?a\.?$/i.test(item) && !/^暂无(?:总结|内容)?[。.]?$/u.test(item));
  return unique(points).slice(0, limit);
}

export function fallbackSummaryPoints(text, title = "", maxItems = 3) {
  const source = String(text || "")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/\r\n/g, "\n");
  const semantic = [];
  const bullets = [];
  const paragraphs = [];
  let section = "";
  for (const line of source.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      section = normalizeHeading(heading[1]);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed || /^[-*_]{3,}$/.test(trimmed)) continue;
    const bullet = trimmed.match(/^[-*]\s+(.+)$/) || trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (bullet) {
      const item = cleanListItem(bullet[1]);
      if (item) {
        bullets.push(item);
        if (SUMMARY_SECTION_HEADINGS.has(section)) semantic.push(item);
      }
      continue;
    }
    if (SUMMARY_SECTION_HEADINGS.has(section) && !trimmed.startsWith("<")) {
      const paragraph = cleanListItem(trimmed);
      if (paragraph) {
        paragraphs.push(paragraph);
        semantic.push(paragraph);
      }
    }
  }
  const preferred = normalizeSummaryPoints(semantic, maxItems);
  if (preferred.length) return preferred;
  const general = normalizeSummaryPoints(bullets, maxItems);
  if (general.length) return general;
  const paragraphPoints = normalizeSummaryPoints(paragraphs, maxItems);
  if (paragraphPoints.length) return paragraphPoints;
  const firstParagraph = source
    .split(/\n\s*\n/)
    .map((item) => cleanListItem(item.replace(/^#{1,6}\s+/gm, "")).replace(/\s+/g, " ").trim())
    .find((item) => item && !item.startsWith("```"));
  const fallback = normalizeSummaryPoints(firstParagraph || title, 1);
  return fallback.length ? fallback : ["原始材料已收录，暂无结构化摘要。"];
}

export function extractSectionItems(text, headings) {
  const wanted = new Set(headings.map(normalizeHeading));
  const sectionLines = [];
  let capturing = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      const normalized = normalizeHeading(heading[1]);
      if (capturing && !wanted.has(normalized)) break;
      capturing = wanted.has(normalized);
      continue;
    }
    if (capturing) sectionLines.push(line);
  }
  const items = [];
  for (const line of sectionLines) {
    const trimmed = line.trim();
    const bullet = trimmed.match(/^[-*]\s+(.+)$/) || trimmed.match(/^\d+\.\s+(.+)$/);
    if (bullet) items.push(cleanListItem(bullet[1]));
  }
  if (items.length) return items;
  const fallback = sectionLines.map(cleanListItem).filter(Boolean).join(" ");
  return fallback ? [fallback] : [];
}

export async function walkFiles(root, predicate = () => true) {
  const files = [];
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(fullPath, predicate));
    else if (entry.isFile() && predicate(fullPath)) files.push(fullPath);
  }
  return files;
}

export function isTextFile(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function relativePath(workspaceRoot, filePath) {
  return path.relative(workspaceRoot, filePath).split(path.sep).join("/");
}

// Card identity is random, so duplicate detection must use only submitted content.
export function normalizeCardContent(data = {}, body = "") {
  const fields = {};
  for (const key of ["human_event_id", "topic_id", "author", "card_type", "title", "summary"]) {
    if (data[key] !== undefined && data[key] !== null) fields[key] = String(data[key]).trim();
  }
  for (const key of ["key_points", "perspectives", "conclusions", "next_steps"]) {
    if (data[key] !== undefined && data[key] !== null) fields[key] = arrayValue(data[key]);
  }
  return JSON.stringify({ fields, body: String(body || "").replace(/\r\n/g, "\n").trim() });
}

export function cardContentHash(data = {}, body = "") {
  return "sha256:" + crypto.createHash("sha256").update(normalizeCardContent(data, body), "utf8").digest("hex");
}

export function publicUrl(workspaceRoot, filePath) {
  return "/collaborate/" + relativePath(workspaceRoot, filePath).split("/").map(encodeURIComponent).join("/");
}

export function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

export async function readJson(filePath, ...fallbackValues) {
  const hasFallback = fallbackValues.length > 0;
  const fallback = fallbackValues[0];
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && hasFallback) return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value, mode = 0o664) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o2775 });
  const temporary = filePath + "." + process.pid + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, mode).catch(() => {});
}

export async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o2775 });
  await fs.appendFile(filePath, JSON.stringify(value) + "\n", { mode: 0o664 });
  await fs.chmod(filePath, 0o664).catch(() => {});
}
