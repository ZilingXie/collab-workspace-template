---
action_id: fanout-task-creation
status: active
fact_status: confirmed
source_refs:
  - 03-decisions/project-process-design.md
  - 09-tasks/README.md
updated_at: 2026-08-14
---

# Fan-out Task Creation

当一个项目动作需要同时收集 Zac 和 Vivi 的反馈时，Hermes 调用 `project_fanout_create` 受控工具。WeCom 不需要、也不得获得 terminal、code execution 或临时脚本执行权限。

一次调用创建 4 个本地 Task：父收集 Task、Hermes 拆分 Task、Zac 子 Task 和 Vivi 子 Task。四个 Task 都有 Task Card；只有两个子 Task 进入 Dispatcher 和 AgentRelay。

未指定 `due_at` 时，父任务和两个子任务从创建时间起默认 72 小时到期。父任务到期后按子任务最新状态生成 `full`、`partial` 或 `no_response`，不要求两个子任务都主动完成。

重复调用使用 `origin_ref` 和标题幂等，不重复创建或派发。风险等级只允许 L0-L2；不存在的 Topic、非法 assignee、缺失来源或 L3 请求必须拒绝。

## 输入材料

需要评审 Briefing 时，Fan-out 必须携带 `input_artifacts`。每个输入材料至少包含 `artifact_id`、`kind`、`title`、Workspace `path`、`url`、`sha256` 和 `required`。这些字段会复制到父 Task、拆分 Task、两个子 Task 和 Task Card；Dispatcher 派发时把完整 Markdown 作为第二个文本 Part 发送。

`input_artifacts` 是目标 Agent 的输入，不是 Relay `artifacts`。Relay `artifacts` 只有在 Zac/Vivi 提交评审结果后才出现。文件不存在、哈希不匹配、路径越界或 URL 无效时，Task 保持 blocked，不创建新的 Relay Task。

## 子 Task Result

子 Task 完成后，Project Hermes 先保存完整 Result Envelope，再刷新父、拆分和子 Task Card。父 Task 的收敛摘要可以使用子 Result，但不得把原始子 Task Card 重写成只有父任务摘要。相同 AgentRelay Message 重放必须复用 Result，不重复创建 Card。
