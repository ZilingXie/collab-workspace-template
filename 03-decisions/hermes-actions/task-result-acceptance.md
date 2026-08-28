---
action_id: task-result-acceptance
status: active
fact_status: confirmed
source_refs:
  - 03-decisions/project-process-design.md
  - 03-decisions/project-hermes-rules.md
updated_at: 2026-08-14
---

# Task Result Acceptance

Hermes 收到 Artifact 或 AgentRelay 回执后，读取原 Task、done criteria、依赖和审计记录，逐条验收。只有 Project Hermes 创建且由 Hermes 负责验收的普通 Task 才能由 Hermes 关闭。

不满足标准时继续要求修改并保持未完成；满足标准时更新原 Task Card 和本地状态。Task 完成只更新 Task Card，不额外生成 Hermes Personal Card。L3 结果不能通过普通回执获批。

## Result Envelope v1

验收完成前先保存 `09-tasks/tasks/<task-id>/results/<result-id>.json` 和 Markdown 镜像。Result 的 `submitted_text` 必须来自当前 AgentRelay Message 的完整文本 Part，不能只使用模型生成的 completion summary；Relay Artifacts、`summary_points`、`verification` 和 `blockers` 也必须保留。相同 `source_message_id` 重放使用同一个 Result ID，已完成 Task 允许补写 Result 但不改变终态和完成时间。

随后 `task-sync` 更新 `task.json` 的最新 Result 指针、追加 `result_received`/`result_accepted` 审计并渲染 Task Card。Fan-out 刷新必须从 Task Result 读取子任务详情。`card_submission` 是仅更新状态的例外，不生成 Result。没有可验证的原始 Relay Message 时，不得用摘要回填完整提交内容。
