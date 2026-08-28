---
document_type: hermes_action_index
status: active
fact_status: confirmed
source_refs:
  - 03-decisions/hermes-runtime/README.md
  - 03-decisions/project-process-design.md
updated_at: 2026-08-14
---

# Hermes Actions

本目录是已沉淀动作流程的索引，不是 Hermes 的能力白名单，也不要求用户使用固定表达。

| Action | 适用范围 |
|---|---|
| `ingest-conversation` | 会议记录、聊天记录或 transcript 入库 |
| `task-assignment` | 从明确 Topic/Task 派发工作 |
| `fanout-task-creation` | 通过受控工具创建多协作者反馈的父、拆分和子 Task |
| `task-result-acceptance` | 接收、验收和关闭 Hermes 负责的 Task |
| `meeting-briefing` | 会前当前进度、参与者进度和建议主题 |
| `quoted-message-explanation` | 结合人物、字典和共识解释引用消息 |
| `human-event-convergence` | 收敛 Human Event、Topic 和候选 Task |
| `personal-card-ingest` | 归档 Zac/Vivi Personal Card |
| `project-question` | 回答项目身份、规则、入口和架构问题 |
| `project-status-query` | 查询当前 Topic、Task、Card 或 Human Event 状态 |
| `memory-write-and-correction` | 受控写入或修正项目 Memory，并创建 Correction Task/Task Card |
| `identity-resolution` | 仅在动作必须确定归属时确认并私下绑定 WeCom 用户身份 |
| `general-project-action` | 未收录但明确、安全、可逆的项目动作 |

Guide 中的示例是语义参考，不是关键词匹配规则。多个 Action 可以组合执行，但必须先明确依赖顺序和每个动作的审计结果。
