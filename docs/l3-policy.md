# Project Hermes L3 Hard Prohibition

Internal governance document. This file is intentionally excluded from the public file manifest and `workspace.html#process`.

## Boundary

- L0, L1, and L2 actions are allowed under their existing workspace and AgentRelay controls.
- L3 actions are hard denied. Human approval in chat, a Review decision, or an incorrect `risk_level` label cannot override the denial.
- Classification applies to actions inside a request, not only its title or declared risk level.
- A structured Human Event may continue materializing safe L0-L2 Tasks while each prohibited candidate is marked `rejected_l3`.
- An unstructured request that mixes safe and L3 execution is rejected as a whole. Hermes may propose a separately scoped L0-L2 alternative, but cannot infer and execute a partial rewrite silently.

## Rule Categories

- `L3-DATA-001`: irreversible or broad data destruction.
- `L3-IDENTITY-001`: credential, identity, or privileged-access mutation.
- `L3-SECURITY-001`: weakening security, authorization, backup, or audit controls.
- `L3-PRODUCTION-001`: high-impact production operations or irreversible migrations.
- `L3-EXTERNAL-001`: external commitments or representations on behalf of humans.
- `L3-FINLEGAL-001`: financial transactions or binding legal actions.
- `L3-PRIVACY-001`: sensitive-data or secret exfiltration.
- `L3-GOVERNANCE-001`: governance/audit tampering or weakening this boundary.
- `L3-AUTOMATION-001`: unbounded automation, unknown-agent fan-out, or uncontrolled scope expansion.

## Enforcement Points

1. Task Registry checks before assigning a local Task ID.
2. Human Event finalization checks every candidate before materialization.
3. Immediate and legacy daily dispatchers check before AgentRelay creation.
4. Project Hermes Worker checks inbound AgentRelay Messages before invoking Hermes.
5. Existing completion policy continues to reject L3 completion.

Policy or audit files missing or invalid must fail closed.

## Audit

Blocked actions append to `.hermes/audit/l3-blocks.jsonl` with timestamp, rule IDs, category, source, safe identifiers, and L0-L2 alternatives. The audit record must not include request text, credentials, tokens, or raw secrets.

