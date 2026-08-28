#!/usr/bin/env node
// Scaffold a new collab workspace from this template.
// Usage: node bin/init.mjs <target-dir> [--title "项目名"] [--manager <person>] [--manager-agent <agent-id>] [--participants zac,vivi] [--no-git]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const target = process.argv[2];
if (!target || target.startsWith("--")) {
  console.error("Usage: node bin/init.mjs <target-dir> [--title ...] [--manager ...] [--manager-agent ...] [--participants a,b] [--no-git]");
  process.exit(1);
}
const title = argument("--title", path.basename(path.resolve(target)));
const managerName = argument("--manager", "Zac");
const managerAgent = argument("--manager-agent", "zac-agent");
const participants = argument("--participants", "zac,vivi").split(",").map((item) => item.trim()).filter(Boolean);
const withGit = !process.argv.includes("--no-git");

const workspaceRoot = path.resolve(target);
await fs.mkdir(workspaceRoot, { recursive: true });
if (await exists(path.join(workspaceRoot, "workspace.config.json"))) {
  console.error(`Refusing to overwrite existing workspace: ${workspaceRoot}`);
  process.exit(1);
}

// 1. Framework engine (vendored copy so each workspace is self-contained)
await copyDirectory(path.join(templateRoot, "scripts"), path.join(workspaceRoot, "scripts"));

// 2. Protocol and runtime documents
for (const name of ["hermes-actions", "hermes-runtime", "hermes-policies"]) {
  await copyDirectory(path.join(templateRoot, "03-decisions", name), path.join(workspaceRoot, "03-decisions", name));
}
for (const name of ["project-hermes-rules.md", "project-process-design.md", "agentrelay-integration-rules.md"]) {
  await copyFile(path.join(templateRoot, "03-decisions", name), path.join(workspaceRoot, "03-decisions", name));
}
for (const [from, to] of [
  ["09-tasks/README.md", "09-tasks/README.md"],
  ["10-memory/README.md", "10-memory/README.md"],
  ["10-memory/retrieval-rules.md", "10-memory/retrieval-rules.md"],
  ["08-cards/human-events/README.md", "08-cards/human-events/README.md"],
  [".hermes/l3-policy.json", ".hermes/l3-policy.json"]
]) {
  await copyFile(path.join(templateRoot, from), path.join(workspaceRoot, to));
}

// 3. Dashboard shell and agent protocol
await copyFile(path.join(templateRoot, "dashboard", "workspace.html"), path.join(workspaceRoot, "workspace.html"));
await copyFile(path.join(templateRoot, "AGENTS.md"), path.join(workspaceRoot, "AGENTS.md"));

// 4. Directory skeleton (runtime scripts also self-heal these, created here for clarity)
const directories = [
  "01-raw/intakes",
  "02-notes/intakes",
  "02-notes/wiki",
  "04-reports",
  "05-agent-outputs",
  "06-pdca",
  "07-state",
  "08-cards/cards",
  "08-cards/contents",
  "08-cards/events",
  "08-cards/human-events/records",
  "08-cards/topics",
  "08-cards/processing",
  "08-cards/review",
  "08-cards/draft-routing/processing",
  "08-cards/legacy/ignored",
  "08-cards/quarantine",
  "09-tasks/tasks",
  "10-memory/people",
  "10-memory/project",
  "10-memory/dictionary",
  "10-memory/consensus",
  "10-memory/corrections",
  "10-memory/methods",
  "public-data/versions",
  ...participants.map((person) => `08-cards/inbox/${person}-draft`)
];
for (const dir of directories) await fs.mkdir(path.join(workspaceRoot, dir), { recursive: true, mode: 0o2775 });

// 5. Fresh workspace files
const slug = (person) => person.trim().toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "-");
await writeJson(path.join(workspaceRoot, "workspace.config.json"), {
  schema_version: 1,
  title,
  status: "初始化",
  goal: "在共享 workspace 中验证人与 Agent 的协作协议：材料入库、索引、状态压缩、纠正沉淀。",
  creator: { name: managerName, avatar: managerName.slice(0, 1).toUpperCase(), tone: "blue" },
  owner: { name: `${title} Hermes`, avatar: "H", tone: "hermes" },
  participants: participants.map((person, index) => ({
    name: person.charAt(0).toUpperCase() + person.slice(1),
    avatar: person.slice(0, 1).toUpperCase(),
    tone: index === 0 ? "blue" : "vivi",
    kind: index === 0 ? "人类" : "人类",
    portrait: "（补充：这个参与者的关注点和偏好）"
  })),
  tabs: [
    { id: "dynamic", label: "项目动态" },
    { id: "plan", label: "任务看板" },
    { id: "human-events", label: "交流记录" },
    { id: "topics", label: "项目议题" },
    { id: "files", label: "文件视图" },
    { id: "people", label: "人物关系" },
    { id: "process", label: "用户手册" }
  ],
  config: [],
  links: {
    agentrelay_dashboard: ""
  },
  refresh_interval_ms: 30000,
  timezone: "Asia/Shanghai"
});

await fs.writeFile(path.join(workspaceRoot, "03-decisions", "project-roles.json"), JSON.stringify({
  schema_version: 1,
  project_manager: {
    person: managerName,
    agent_id: managerAgent,
    role: "project_manager"
  },
  participants: participants.map((person) => ({
    key: slug(person),
    name: person.charAt(0).toUpperCase() + person.slice(1),
    agent_id: `${slug(person)}-agent`
  }))
}, null, 2) + "\n");

await fs.writeFile(path.join(workspaceRoot, "07-state", "PROJECT_STATE.md"), [
  `# Project State — ${title}`,
  "",
  `更新时间：${new Date().toISOString().slice(0, 10)}`,
  "维护者：Project Hermes",
  "",
  "## 当前状态",
  "",
  "- Workspace 已通过 collab-workspace-template 初始化。",
  "- 材料：丢入 `08-cards/inbox/<participant>-draft/` 或消息入口。",
  "",
  "## 下一步",
  "",
  "1. 投放第一批真实材料并运行 ingestion。",
  "2. 确认 Human Event 与卡片生成。",
  ""
].join("\n"));

await fs.writeFile(path.join(workspaceRoot, "06-pdca", "failure-examples.md"), [
  "# PDCA 失败样例",
  "",
  "记录流程失效、人类纠正和修正措施。格式：",
  "",
  "## #N 日期 — 一句话标题",
  "- 现象：",
  "- 根因：",
  "- 修正：",
  "- 沉淀：（规则/记忆候选，注明去向）",
  ""
].join("\n"));

await fs.writeFile(path.join(workspaceRoot, "README.md"), [
  `# ${title}`,
  "",
  "基于 [collab-workspace-template](https://github.com/ZilingXie/collab-workspace-template) 的人机共享 workspace。",
  "",
  "- 入口文档：`AGENTS.md`（Agent 协议）、`07-state/PROJECT_STATE.md`（当前状态）",
  "- 材料：`08-cards/inbox/<participant>-draft/`",
  "- 流水线：`node scripts/hermes-09-ingest.mjs`（每日定时见 `system/`）",
  ""
].join("\n"));

await fs.writeFile(path.join(workspaceRoot, ".gitignore"), [
  ".env",
  ".env.*",
  "!.env.example",
  "*.token",
  "*.secret",
  "*.pem",
  "*.key",
  "logs/",
  "tmp/",
  "runtime/",
  "processing/",
  "08-cards/processing/",
  ".hermes/audit/",
  ".hermes/runtime/",
  ".hermes/session/",
  ".hermes/quarantine/",
  ".hermes/result-envelopes/",
  "09-tasks/dispatch_queue.json",
  "08-cards/ingestion_log.jsonl",
  "public-data/versions/",
  ".DS_Store",
  ""
].join("\n"));

// 6. Git
if (withGit) {
  const result = spawnSync("git", ["init", "-b", "main"], { cwd: workspaceRoot });
  if (result.status === 0) {
    spawnSync("git", ["add", "-A"], { cwd: workspaceRoot });
    spawnSync("git", ["commit", "-m", "chore: init workspace from collab-workspace-template"], { cwd: workspaceRoot });
  }
}

console.log(`Workspace created: ${workspaceRoot}`);
console.log("");
console.log("Next steps:");
console.log("  1. Edit workspace.config.json (title, participants) and 03-decisions/project-roles.json");
console.log("  2. Drop material into 08-cards/inbox/<participant>-draft/");
console.log("  3. Run: node scripts/hermes-09-ingest.mjs   (needs PROJECT_HERMES_COMMAND pointing at your Hermes CLI)");
console.log("  4. Publish: node scripts/publish-workspace.mjs --full --reason init");
console.log("  5. Install automation: see system/README.md for systemd units");
console.log("  6. Agent onboarding: point agents at AGENTS.md in this workspace");

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function copyDirectory(from, to) {
  await fs.mkdir(to, { recursive: true, mode: 0o2775 });
  const result = spawnSync("cp", ["-r", from + "/.", to + "/"]);
  if (result.status !== 0) throw new Error(`copy failed: ${from} -> ${to}: ${result.stderr}`);
}

async function copyFile(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o2775 });
  await fs.copyFile(from, to);
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");
}
