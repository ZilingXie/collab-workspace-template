---
document_type: hermes_workspace_boundary
status: active
fact_status: confirmed
source_refs:
  - README.md
  - 03-decisions/project-hermes-rules.md
updated_at: 2026-08-14
---

# Workspace Boundary

消息入口绑定的项目 Workspace 由 `COLLAB_WORKSPACE` 环境变量或脚本所在目录的上一级决定。

- 项目事实必须优先来自当前 Workspace 和正式规则。
- 不读取 Zac 的私人 Hermes Memory、私人微信内容或其他项目目录。
- `10-memory/` 是当前项目的文件式 Memory，不使用私人 AgentMemory 代替它。
- 本群内的 Memory 读取和写入不得转向 `private-info`、Hermes 内置 Memory、主机级 AGENTS 或其他项目。历史聊天或旧材料提到这些系统，不代表它们仍是当前可用通道。
- 项目页面、入口和别名读取 `10-memory/project/`，不要依赖固定 Prompt 或旧会话。
- Raw、日志、凭据和内部审计不是公开文件视图内容。
