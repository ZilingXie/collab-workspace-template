import crypto from "node:crypto";

const REDACTION = "[REDACTED]";
const SECRET_CONTEXT = /(?:token|secret|password|passwd|credential|api[_ -]?key|access[_ -]?key|authorization|bearer|签名|密钥|密码|凭据)/i;

export function redactText(value) {
  let text = String(value ?? "");
  const findings = [];
  text = text.replace(/\b(Bearer\s+)([A-Za-z0-9._~+\/-]{12,}=*)/gi, (_match, prefix, secret) => {
    findings.push({ type: "bearer_token", fingerprint: fingerprint(secret) });
    return `${prefix}${REDACTION}`;
  });
  text = text.replace(/([?&](?:access_token|api_key|apikey|token|secret|password|signature)=)([^&#\s]+)/gi, (_match, prefix, secret) => {
    findings.push({ type: "url_credential", fingerprint: fingerprint(secret) });
    return `${prefix}${REDACTION}`;
  });
  text = text.replace(/(https?:\/\/[^\s/@:]+:)([^\s/@]+)(@)/gi, (_match, prefix, secret, suffix) => {
    findings.push({ type: "url_basic_credential", fingerprint: fingerprint(secret) });
    return `${prefix}${REDACTION}${suffix}`;
  });
  text = text.replace(/\b((?:access[_ -]?token|api[_ -]?key|token|secret|password|passwd|credential|authorization|密钥|密码|凭据)\s*[:=]\s*["']?)([^\s,"'<>]{8,})/gi, (_match, prefix, secret) => {
    findings.push({ type: "credential_assignment", fingerprint: fingerprint(secret) });
    return `${prefix}${REDACTION}`;
  });
  text = text.replace(/[A-Za-z0-9_\-./+=]{32,}/g, (candidate, offset, whole) => {
    const context = whole.slice(Math.max(0, offset - 48), Math.min(whole.length, offset + candidate.length + 48));
    if (!SECRET_CONTEXT.test(context) || entropy(candidate) < 3.5) return candidate;
    findings.push({ type: "contextual_high_entropy", fingerprint: fingerprint(candidate) });
    return REDACTION;
  });
  return { text, findings: dedupeFindings(findings) };
}

export function redactStructured(value) {
  const findings = [];
  const visit = (item) => {
    if (typeof item === "string") {
      const result = redactText(item);
      findings.push(...result.findings);
      return result.text;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    }
    return item;
  };
  return { value: visit(value), findings: dedupeFindings(findings) };
}

export function verifyEvidenceQuotes(sourceText, quotes, sourceRef) {
  const source = String(sourceText ?? "");
  const normalizedSource = normalizeWithOffsets(source);
  const evidence = [];
  for (const rawQuote of Array.isArray(quotes) ? quotes : []) {
    const quote = String(rawQuote ?? "").trim();
    if (!quote) continue;
    let start = source.indexOf(quote);
    let end = start < 0 ? -1 : start + quote.length;
    let verification = "exact";
    if (start < 0) {
      const normalizedQuote = normalizeWhitespace(quote);
      const normalizedStart = normalizedSource.text.indexOf(normalizedQuote);
      if (normalizedStart < 0) continue;
      start = normalizedSource.offsets[normalizedStart];
      const lastOffset = normalizedSource.offsets[normalizedStart + normalizedQuote.length - 1];
      end = Math.min(source.length, lastOffset + 1);
      verification = "whitespace_normalized";
    }
    const redacted = redactText(source.slice(start, end)).text.replace(/\s+/g, " ").trim();
    evidence.push({
      source_ref: sourceRef,
      line_start: lineAt(source, start),
      line_end: lineAt(source, Math.max(start, end - 1)),
      excerpt_redacted: truncate(redacted, 200),
      verification
    });
  }
  return dedupeEvidence(evidence);
}

export function hasVerifiedEvidence(candidate) {
  return Array.isArray(candidate?.evidence) && candidate.evidence.some((item) => ["exact", "whitespace_normalized"].includes(item?.verification));
}

export function classifyActors(values) {
  const sourceActorNames = [...new Set((Array.isArray(values) ? values : []).map((item) => String(item || "").trim()).filter(Boolean))];
  const participants = [];
  const agentParticipants = [];
  const systemActors = [];
  for (const name of sourceActorNames) {
    const lowered = name.toLowerCase();
    if (lowered.includes("todos")) systemActors.push("ToDos");
    else if (lowered.includes("shadowzac") || lowered.includes("project hermes") || lowered === "hermes") agentParticipants.push("Project Hermes");
    else if (lowered.includes("codex")) agentParticipants.push(lowered.includes("vivi") ? "Vivi Codex" : (lowered.includes("zac") ? "Zac Codex" : name));
    else if (lowered.includes("vivi") || name.includes("杨元")) participants.push("Vivi");
    else if (lowered.includes("zac") || name.includes("谢子凌")) participants.push("Zac");
  }
  return {
    participants: [...new Set(participants)],
    agent_participants: [...new Set(agentParticipants)],
    system_actors: [...new Set(systemActors)],
    source_actor_names: sourceActorNames
  };
}

function normalizeWithOffsets(value) {
  let text = "";
  const offsets = [];
  let pendingSpace = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (/\s/.test(char)) {
      pendingSpace = text.length > 0;
      continue;
    }
    if (pendingSpace) {
      text += " ";
      offsets.push(index);
      pendingSpace = false;
    }
    text += char;
    offsets.push(index);
  }
  return { text: text.trim(), offsets };
}

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function lineAt(value, offset) {
  return value.slice(0, Math.max(0, offset)).split("\n").length;
}

function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  return [...counts.values()].reduce((sum, count) => {
    const probability = count / value.length;
    return sum - probability * Math.log2(probability);
  }, 0);
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function dedupeFindings(values) {
  return [...new Map(values.map((item) => [`${item.type}:${item.fingerprint}`, item])).values()];
}

function dedupeEvidence(values) {
  return [...new Map(values.map((item) => [`${item.source_ref}:${item.line_start}:${item.line_end}:${item.excerpt_redacted}`, item])).values()];
}
