import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

export function loadProjectHermesModelConfig(env = process.env) {
  const hermesHome = env.HERMES_HOME || path.join(os.homedir(), ".hermes");
  const configPath = env.PROJECT_HERMES_CONFIG || path.join(hermesHome, "config.yaml");
  const python = env.PROJECT_HERMES_CONFIG_PYTHON || path.join(hermesHome, "hermes-agent", "venv", "bin", "python");
  const code = [
    "import json, sys, yaml",
    "with open(sys.argv[1], encoding='utf-8') as handle:",
    "    data = yaml.safe_load(handle) or {}",
    "print(json.dumps(data.get('project_hermes') or {}))"
  ].join("\n");
  try {
    return JSON.parse(execFileSync(python, ["-c", code, configPath], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"]
    }));
  } catch {
    return {};
  }
}

export function parseJsonObject(text) {
  const value = String(text || "").trim();
  const candidates = [
    value,
    value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1],
    value.slice(value.indexOf("{"), value.lastIndexOf("}") + 1)
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next JSON candidate.
    }
  }
  throw new Error("Hermes did not return a JSON object");
}

export async function readJsonObjectFile(filePath) {
  return parseJsonObject(await fs.readFile(filePath, "utf8"));
}

export function runHermesCommand({
  command,
  prompt,
  cwd,
  env,
  maxTurns,
  timeoutMs,
  toolsets = null,
  model = null,
  provider = null
}) {
  return new Promise((resolveRun) => {
    const args = ["chat", "--quiet", "--accept-hooks", "--max-turns", String(maxTurns)];
    if (toolsets) args.push("--toolsets", toolsets);
    if (model) args.push("--model", model);
    if (provider) args.push("--provider", provider);
    args.push("--query", prompt);
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ code: 1, stdout, stderr: `${stderr}\n${error.message}`.trim(), timed_out: timedOut, model, provider, latency_ms: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? 1, stdout, stderr, timed_out: timedOut, model, provider, latency_ms: Date.now() - startedAt });
    });
  });
}
