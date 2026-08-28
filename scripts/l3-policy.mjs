import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class L3PolicyError extends Error {
  constructor(decision) {
    super(`L3 action prohibited: ${decision.rule_ids.join(", ")}`);
    this.name = "L3PolicyError";
    this.code = "L3_ACTION_PROHIBITED";
    this.decision = decision;
  }
}

export async function loadL3Policy(workspaceRoot, policyPath = "") {
  let resolved = policyPath
    ? path.resolve(policyPath)
    : path.join(workspaceRoot, ".hermes", "l3-policy.json");
  try {
    await fs.access(resolved);
  } catch {
    if (policyPath) throw new Error(`Project Hermes L3 policy not found: ${resolved}`);
    resolved = fileURLToPath(new URL("../.hermes/l3-policy.json", import.meta.url));
  }
  const policy = JSON.parse(await fs.readFile(resolved, "utf8"));
  return validateL3Policy(policy);
}

export function validateL3Policy(policy) {
  if (!policy || policy.schema_version !== 1 || policy.enforcement !== "hard_deny") {
    throw new Error("Invalid Project Hermes L3 policy");
  }
  if (policy.human_override_allowed !== false) {
    throw new Error("Project Hermes L3 policy must not allow human overrides");
  }
  if (!Array.isArray(policy.rules) || !policy.rules.length) {
    throw new Error("Project Hermes L3 policy has no rules");
  }
  const ids = new Set();
  for (const rule of policy.rules) {
    if (!rule?.id || ids.has(rule.id) || !Array.isArray(rule.patterns) || !rule.patterns.length) {
      throw new Error(`Invalid Project Hermes L3 rule: ${rule?.id || "missing"}`);
    }
    ids.add(rule.id);
    for (const pattern of rule.patterns) new RegExp(pattern, "iu");
  }
  return policy;
}

export function evaluateL3Request(input, policy, { source = "unknown" } = {}) {
  const declaredRisk = String(input?.risk_level || "").trim().toUpperCase();
  const text = requestText(input);
  const analysisOnly = isAnalysisOnly(text);
  const matches = [];
  if (declaredRisk === "L3") {
    matches.push({
      id: "L3-DECLARED-001",
      category: "declared_l3",
      reason: "The request is explicitly classified as L3.",
      alternatives: ["Redesign the action as a bounded, reversible L0-L2 task for human review."]
    });
  }
  if (!analysisOnly) {
    for (const rule of policy.rules) {
      if (rule.patterns.some((pattern) => new RegExp(pattern, "iu").test(text))) matches.push(rule);
    }
  }
  const uniqueMatches = [...new Map(matches.map((rule) => [rule.id, rule])).values()];
  return {
    policy_id: policy.policy_id,
    blocked: uniqueMatches.length > 0,
    enforcement: "hard_deny",
    human_override_allowed: false,
    source,
    declared_risk_level: declaredRisk || null,
    analysis_only: analysisOnly,
    rule_ids: uniqueMatches.map((rule) => rule.id),
    categories: uniqueMatches.map((rule) => rule.category),
    reasons: uniqueMatches.map((rule) => rule.reason),
    alternatives: [...new Set(uniqueMatches.flatMap((rule) => rule.alternatives || []))].slice(0, 6)
  };
}

export async function assertL3Allowed(workspaceRoot, input, options = {}) {
  const policy = options.policy || await loadL3Policy(workspaceRoot, options.policyPath);
  const decision = evaluateL3Request(input, policy, options);
  if (!decision.blocked) return decision;
  await appendL3Audit(workspaceRoot, policy, decision, options.audit || {});
  throw new L3PolicyError(decision);
}

export async function appendL3Audit(workspaceRoot, policy, decision, details = {}) {
  const auditPath = path.join(workspaceRoot, policy.audit_path || ".hermes/audit/l3-blocks.jsonl");
  await fs.mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
  const entry = {
    at: new Date().toISOString(),
    type: "l3_action_blocked",
    policy_id: policy.policy_id,
    rule_ids: decision.rule_ids,
    categories: decision.categories,
    source: decision.source,
    requester_id: cleanId(details.requester_id),
    local_task_id: cleanId(details.local_task_id),
    relay_task_id: cleanId(details.relay_task_id),
    human_event_id: cleanId(details.human_event_id),
    action_ref: cleanId(details.action_ref),
    alternatives: decision.alternatives
  };
  await fs.appendFile(auditPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await fs.chmod(auditPath, 0o600).catch(() => {});
  return entry;
}

export function formatL3Refusal(decision) {
  const rules = decision.rule_ids.join(", ");
  const alternatives = decision.alternatives.slice(0, 3).map((item) => `- ${item}`).join("\n");
  return [
    `Project Hermes refused this request because it contains a prohibited L3 action (${rules}).`,
    "Human approval in chat cannot override this boundary.",
    alternatives ? `Allowed L0-L2 alternatives:\n${alternatives}` : "Redesign the request as a bounded, reversible L0-L2 action."
  ].join("\n\n");
}

function requestText(input) {
  const parts = [input?.title, input?.subject, input?.content, input?.request_text, input?.done_criteria];
  if (Array.isArray(input?.parts)) parts.push(...input.parts.map((part) => part?.text));
  if (Array.isArray(input?.messages)) {
    parts.push(...input.messages.flatMap((message) => (message?.parts || []).map((part) => part?.text)));
  }
  if (Array.isArray(input?.assignees)) {
    parts.push(...input.assignees.flatMap((assignee) => [
      assignee?.title,
      assignee?.content,
      assignee?.done_criteria
    ]));
  }
  return parts.filter((value) => typeof value === "string").join("\n").slice(0, 120000);
}

function isAnalysisOnly(text) {
  const explicitlyNonExecuting = /(不执行|不要执行|不得执行|只读|仅分析|仅评估|只提供方案|只给计划|without executing|do not execute|read[- ]only|analysis only|plan only)/iu.test(text);
  const analyticalIntent = /(分析|评估|审查|解释|方案|计划|runbook|review|assess|analy[sz]e|explain|proposal|plan)/iu.test(text);
  const contradictoryExecution = /(然后|并且|同时|after that|then|and then).{0,20}(执行|实施|删除|修改|发送|部署|execute|apply|delete|change|send|deploy)/iu.test(text);
  return explicitlyNonExecuting && analyticalIntent && !contradictoryExecution;
}

function cleanId(value) {
  const normalized = String(value || "").trim();
  return normalized && /^[A-Za-z0-9._:@/-]{1,240}$/.test(normalized) ? normalized : null;
}
