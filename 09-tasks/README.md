# Task Registry

每个正式 Topic Task 位于：

```text
09-tasks/tasks/<task-id>/
├── task.json
├── audit.jsonl
└── results/
    ├── <result-id>.json
    └── <result-id>.md
```

`task.json` 是当前状态，`audit.jsonl` 是追加式审计记录。`task_index.json` 由 Hermes 自动生成，供 `workspace.html` 使用。

依赖 Human Event 最终产物的 Task 使用：

- `blocked_by_human_event_ids`：这些 Event 全部达到 `materialized` 后才可派发。
- `not_before`：最早派发时间；早于该时间时 queue 状态为 `blocked`。
- `due_at`：派发后的完成截止时间，不得替代 `not_before`。

Dispatcher 必须同时满足 `not_before` 已到达和所有阻塞 Event 已 materialize，才把 queue 从 `blocked` 转为 `pending`。

`dispatch_queue.json` 是本地 Task 到 AgentRelay 的待派发队列。它由 systemd path unit 立即触发 dispatcher，并由一分钟 retry timer 补偿；dispatcher 只消费状态为 `pending` 且风险等级为 L0-L2 的项目任务。

所有任务来源都必须先调用 `scripts/task-registry.mjs`，不得直接 POST AgentRelay：

```bash
node scripts/create-project-task.mjs --input /path/to/task.json
```

Human Event 在 Hermes Card 写入后立即创建并排入 Zac/Vivi 的 `card_submission` 任务。工作日 09:00 执行 ingest/reconcile 和 Hermes 自然语言规划；若某角色已有 active task，则不再为该角色创建 daily narrative task。正式 Task 进入注册表后由即时 Dispatcher 派发；工作日 10:00 只发送所有 pending Zac/Vivi 任务的状态日报，周末不发送。

本地 lifecycle（如 `ready`、`processing`、`completed`）与 Relay delivery（如 `delivered`、`pending listener`）是两个独立维度。`pending listener` 不是业务失败，也不会阻止 Listener 恢复后继续投递。

以下工作流任务不创建 Task Card：

- `card_submission`
- `owner_assignment`
- `human_event_review`

`card_submission` 使用 `workflow` 派发类型。Project Hermes 只有在作者、`human_event_id` 和实际 Personal Card 文件均校验通过时才可以关闭对应 AgentRelay Task；关闭后只更新本地 Task 与审计记录，不生成任务完成 Card。Relay 使用本地 `due_at` 对应的原生 `task_expires_at` 执行 72 小时到期。

Topic Task 与 Task Card 一对一。Task 创建、派发、讨论、回执、验收和完成都更新同一张 Task Card；任务完成后不额外生成 Hermes Personal Card。带 `input_artifacts` 的 Task Card 必须展示输入材料的 ID、链接和 SHA-256。

## Task Result v1

普通 Task 完成时，Hermes 必须保留可追溯的 Result Envelope，而不能只把一段短验收摘要写回 Task Card。Result 的权威正文来自当前 AgentRelay Message 的完整文本 Part；如果有 Relay Artifact，同时保存其 `artifact_id`、标题、路径/URL 和哈希。Hermes 的验收摘要、最多三条 `summary_points`、`verification` 和 `blockers` 作为 Result 元数据保存。

Result ID 由本地 Task、Relay Task、来源 Message 和验收摘要稳定生成。同一 Message 重放只复用现有 Result，不创建第二个 Result 或第二张 Card；不同 Message 的修订结果才新增 Result，并将最新指针写入 `task.json` 的 `latest_result_id`、`latest_result_path` 和 `latest_result_markdown_path`。已完成 Task 仍可通过带 `--result-file` 的同步流程补齐缺失 Result，但不得改变既有完成时间或终态。

Task Card 的详情必须同时展示结果摘要、完整提交内容、Artifacts、验证/阻塞信息、Result 文件路径和审计时间线。Fan-out 刷新父/拆分/子 Card 时必须读取并保留子 Task 的最新 Result，不能用原始 `task.content` 覆盖已完成反馈。`card_submission` 只更新任务状态和审计，不生成 Task Result。

Result 写入前经过安全脱敏；结果 Envelope 只能来自 Workspace 或 Project Hermes 的受控结果目录。历史 Task 只在能从 Worker Relay 快照找到原始 Message 时回填；找不到原文时保持现状并报告缺失，不用模型摘要补造提交内容。

## Fan-out 收集任务

需要收集多个协作者反馈时使用 `task_kind: fanout_collection`，由 `scripts/fanout-collection.mjs` 创建：

```text
fanout_collection（task_role=coordinator，owner=project-hermes）
└── fanout_decomposition（task_role=decomposer，owner=project-hermes）
    ├── fanout_child（task_role=assignee，owner=zac-agent）
    └── fanout_child（task_role=assignee，owner=vivi-agent）
```

父 Task、拆分 Task、子 Task 均有 Task Card。一次 Fan-out 创建 4 个 Task：父 Task、拆分 Task、Zac 子 Task 和 Vivi 子 Task。只有 `fanout_child` 进入 `dispatch_queue.json` 和 AgentRelay；协调者/拆分者不会被派给 Hermes 自己。父 Task 在 `due_at` 到期时由 Hermes 一次性总结所有子 Task 的最新状态，写入 `collection_status`（`full`、`partial`、`no_response`）、`collection_outcome`、`summary` 和父 Task Card；未提供截止时间时默认从创建时间起 72 小时。重复执行按父 Task 的 `dedupe_key` 幂等。WeCom 通过 `project_fanout_create` 受控工具创建，不开放 terminal 或临时脚本执行；子任务创建后立即进入 Dispatcher，10:00 只发送提醒。

同一 Task 再次被 Human Event 讨论时，优先按显式 `task_id` 更新；没有 ID 时，只在同一 Topic 内按规范化标题完全一致自动复用。复用只追加 Human Event、Source 和审计，不创建重复 Task，也不重新派发已经完成或正在执行的 Task。

Briefing 评审 Fan-out 必须先由 Briefing 工作流创建不绑定 Human Event 的 Briefing Topic、初版 MD/JSON 和 Hermes Personal Card，再由 `project_meeting_briefing_review_create` 按 `briefing_id` 校验并创建。初版 Briefing 会作为 `input_artifacts` 传播到父、拆分和子 Task，并在 Relay 初始消息中完整附带；它不填入 Relay `artifacts`。所有评审 Task 完成或默认 72 小时到期后，Hermes 生成最终 Briefing，最终 Briefing 只作为 Topic 摘要按钮展示，不创建最终 Personal Card。明确的 direct 请求跳过初版 Card 和评审 Task，直接生成最终 Briefing。

人工 Review Task 可声明 `timeout_policy: default_no_objection`。到期后 Task 进入 `expired` 并记录 `review_expired_no_objection`；沉默表示未提出异议，不生成虚构的人类确认 Card。该策略不适用于 `card_submission` 或普通执行 Task，L3 永不因沉默获批。
