import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAnalysisPackage, analysisToProposal } from "../analysis-package.mjs";
import { redactText, verifyEvidenceQuotes } from "../analysis-security.mjs";

const sourceRef = "01-raw/intakes/ing-test/source.txt";

test("Analysis v2.1 normalizes typed candidates and preserves Task source state", () => {
  const analysis = normalizeAnalysisPackage({
    schema_version: 2,
    ingest_id: "ing-test",
    source_ref: sourceRef,
    human_event: { title: "Chat", summary_points: ["Summary"], participants: ["Zac", "Vivi"] },
    signal_analysis: {},
    person_candidates: [{ name: "Zac", source_refs: [sourceRef], evidence: [] }],
    dictionary_candidates: [{ term: "Agora", source_refs: [sourceRef], evidence: [] }],
    memory_proposals: [{ proposal: "Use file memory", target: "private-info", source_refs: [sourceRef], evidence: [] }],
    task_candidates: [{ title: "Fix tests", summary: "Repair four tests.", topic_title: "Relay", assignee: "Zac Codex", status: "in_progress", done_criteria: "Tests pass.", source_refs: [sourceRef] }]
  });
  assert.equal(analysis.schema_version, 2.1);
  assert.equal(analysis.person_candidates[0].title, "Zac");
  assert.equal(analysis.dictionary_candidates[0].title, "Agora");
  assert.equal(analysis.memory_proposals[0].target, "10-memory/candidates.md");
  assert.equal(analysis.task_candidates[0].owner, "Zac Codex");
  assert.equal(analysis.task_candidates[0].source_status, "in_progress");
  assert.equal(analysis.task_candidates[0].candidate_status, "candidate");
  const proposal = analysisToProposal(analysis);
  assert.equal(proposal.tasks[0].content, "Repair four tests.");
});

test("redaction removes credentials while evidence retains only a fingerprint-free excerpt", () => {
  const secret = "unit_test_secret_0123456789abcdef";
  const source = `Authorization: Bearer ${secret}\nZac confirmed the workspace link.\n`;
  const redacted = redactText(source);
  assert.equal(redacted.text.includes(secret), false);
  assert.equal(redacted.findings.length, 1);
  assert.equal(JSON.stringify(redacted.findings).includes(secret), false);
  const evidence = verifyEvidenceQuotes(source, ["Zac confirmed the workspace link."], sourceRef);
  assert.deepEqual(evidence[0], {
    source_ref: sourceRef,
    line_start: 2,
    line_end: 2,
    excerpt_redacted: "Zac confirmed the workspace link.",
    verification: "exact"
  });
});

test("evidence allows whitespace normalization but rejects semantic approximation", () => {
  const source = "Zac confirmed\n  the workspace link.";
  assert.equal(verifyEvidenceQuotes(source, ["Zac confirmed the workspace link."], sourceRef)[0].verification, "whitespace_normalized");
  assert.deepEqual(verifyEvidenceQuotes(source, ["Zac approved the workspace URL."], sourceRef), []);
});
