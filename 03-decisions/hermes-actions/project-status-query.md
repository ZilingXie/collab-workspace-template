---
action_id: project-status-query
status: active
fact_status: confirmed
source_refs:
  - 09-tasks/task_index.json
  - 08-cards/card_index.json
  - 07-state/PROJECT_STATE.md
updated_at: 2026-08-14
---

# Project Status Query

查询 Task、Topic、Human Event 或 Card 时，先按显式 ID 精确定位，再读取对应实时文件和审计。没有 ID 且有多个候选时列出候选，不自行猜测或合并。
