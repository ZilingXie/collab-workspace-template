# AgentRelay Integration Rules

Date: 2026-07-01
Owner: Project Hermes
Scope: `collab_workspace`

---

## Decision

AgentRelay is the project task relay layer. It is not the project brain and not the source of project truth.

```text
Project Hermes = project manager agent / workspace owner / fact governance
AgentRelay = transport, durable task state, auth, notification, audit
Local agents = human-facing execution partners
```

## Registered Agents

Current AgentRelay identities used by this project:

| Agent ID | Role |
|---|---|
| `project-hermes` | Shared workspace owner and project management agent |
| `zac-agent` | Zac local agent |
| `vivi-agent` | Vivi local agent |

Other relay agents may exist, but they are outside this project unless explicitly referenced by Project Hermes.

## Flow A: Local Agent Asks Project Hermes To Execute

Use when Zac or Vivi discusses a project change with a local agent and wants Project Hermes to execute or govern the change.

```text
Human -> local agent -> AgentRelay task -> project-hermes
project-hermes claims task -> executes or rejects -> submits artifact
requester local agent evaluates done_criteria -> closes or follows up
```

Required task fields:

```text
requester_agent_id
target_agent_id = project-hermes
subject
request_text / message.parts
source_refs when available
done_criteria
completion_owner_agent_id = requester agent
pending_on_agent_id = project-hermes
```

## Flow B: Project Hermes Dispatches Work To A Human's Agent

Use when the project needs Zac or Vivi to review, decide, or perform local work.

```text
Project Hermes -> AgentRelay task -> zac-agent / vivi-agent
local agent works with human -> submits artifact
Project Hermes evaluates artifact -> updates workspace / state / PDCA
```

For Project Hermes initiated tasks:

```text
requester_agent_id = project-hermes
completion_owner_agent_id = project-hermes
target_agent_id = zac-agent | vivi-agent
```

### Unified Task Dispatch And Daily Status

Status: implemented.

Runtime:

```text
<workspace-root>/09-tasks/
<agent-relay-worker-dir>/task-dispatcher.mjs
<agent-relay-worker-dir>/daily-planner.mjs
<agent-relay-worker-dir>/daily-status-reporter.mjs
systemd: immediate path dispatcher + weekday 09:00 planner + weekday 10:00 status reporter
workspace: <workspace-root>
```

Behavior:

- Every workflow or narrative task is first created in the canonical `09-tasks` registry; only `task-dispatcher.mjs` may create its AgentRelay Task.
- Human Event card-submission tasks are queued immediately after the Hermes Card is written.
- At 09:00 on weekdays, Project Hermes ingests and reconciles workspace state and plans missing actions. A role with any active task is suppressed.
- Local task id provides stable Relay idempotency, so immediate retries do not create duplicate work.
- At 10:00 on weekdays, Project Hermes creates no work and sends an Enterprise WeChat report of every pending Zac/Vivi task. Weekends are silent.
- Reports show Relay delivery and Task lifecycle separately. `waiting_listener` remains pollable and is not a business failure.
- The webhook URL is private worker config and must not be written into source files, task messages, or logs.

## Write Boundaries

- Project Hermes owns writes to `PROJECT_STATE.md`, `file_index.md`, `failure-examples.md`, project rules, and governed workspace updates.
- Local agents may submit relay artifacts and write to their own `05-agent-outputs/<agent>/` area when appropriate.
- Relay messages and artifacts are inputs, not final project facts.
- High-impact project rules, memory writes, or irreversible actions still require human confirmation.

## Smoke Test

On 2026-07-01, the following relay smoke test passed:

```text
zac-agent -> project-hermes
task_id = task_55241dcd570c4334b0c502e51fcb617a
project-hermes claimed task
project-hermes submitted artifact back to zac-agent
zac-agent closed task
final status = completed
```

This proves `project-hermes` is registered, authenticated, addressable, able to claim tasks, and able to return artifacts through AgentRelay.

## Remaining Work

- Add relay task IDs to project dynamics or `PROJECT_STATE.md` when relay tasks affect project state.
