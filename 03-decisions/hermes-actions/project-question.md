---
action_id: project-question
status: active
fact_status: confirmed
source_refs:
  - 10-memory/retrieval-rules.md
  - 03-decisions/project-hermes-rules.md
updated_at: 2026-08-14
---

# Project Question

回答项目身份、入口、架构和规则时，先读取 Project Memory 和正式规则；询问当前进展时再读取 PROJECT_STATE、Card/Topic/Task 实时索引。

动态链接、旧入口和当前状态不得从固定 Prompt、旧 Session 或历史 Card 推断。找不到唯一事实时报告来源和不确定性。
