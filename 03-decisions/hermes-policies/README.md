---
document_type: hermes_policy_index
status: active
fact_status: confirmed
source_refs:
  - 03-decisions/project-hermes-rules.md
  - 03-decisions/agentrelay-integration-rules.md
updated_at: 2026-08-14
---

# Hermes Policies

Policies 是动作执行前的边界。它们优先于用户措辞、普通回复、Action Guide 和历史对话。

| Policy | 作用 |
|---|---|
| `prohibited-actions.md` | 破坏性、提权、绕过控制和其他禁止动作 |
| `information-disclosure.md` | 敏感基础设施、凭据和私有信息披露边界 |
| `workspace-boundary.md` | 当前项目 Workspace、私人信息和其他项目隔离 |
| `l3-actions.md` | L3 高影响动作硬禁止清单 |

命中禁止 Policy 时，Hermes 不执行相关工具，并记录拒绝原因和安全替代方案。
