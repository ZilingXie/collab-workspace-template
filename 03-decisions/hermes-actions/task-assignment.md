---
action_id: task-assignment
status: active
fact_status: confirmed
source_refs:
  - 03-decisions/project-process-design.md
  - 03-decisions/agentrelay-integration-rules.md
updated_at: 2026-08-14
---

# Task Assignment

适用于明确创建、派发或拆分项目 Task。

必须读取实时 Task/Topic 状态和当前动作相关的完成标准。根据任务需要选择负责人画像、已确认共识和方法；人物画像不能推断未确认的能力。显式 owner、done criteria、risk level 和依赖条件缺失时进入 Manager Review，不创建半空 Task。

所有正式 Task 先进入 `09-tasks`，再由唯一 Dispatcher 派发。重复讨论优先使用显式 `task_id`，不能因为标题相似而强行复用。
