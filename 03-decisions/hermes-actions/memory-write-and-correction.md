---
action_id: memory-write-and-correction
status: active
fact_status: confirmed
source_refs:
  - 10-memory/README.md
  - 10-memory/retrieval-rules.md
  - 03-decisions/project-process-design.md
updated_at: 2026-08-14
---

# Memory Write and Correction

只有明确人类陈述、人类纠正、已收敛 Human Event 共识或权威文件指针可以成为 Memory。必须有 source refs、允许的 evidence type、`active` 和 `confirmed` 状态。

推测、候选、临时总结、`need_review` 和模型自行推导内容不得写入。修正使用 `supersedes` 保留历史。解释结果和普通群聊回答不会自动成为 Memory。

本企业微信群中用户明确要求“记住”的项目协作事实，只能写入当前 Workspace 的 `10-memory/`。人物角色档案保留在 `10-memory/people/<person>.md`；工作地点、协作偏好等独立事实写入 `10-memory/people/facts/<person>/` 的 `person_fact` 记录。不得建议或调用私人 AgentMemory、`private-info` 或 Hermes 内置 Memory。写人物事实前必须通过确定性身份映射确认归属，并使用 `project_self_memory_save`；不得使用 `write_file`、`patch` 或 `terminal` 绕过 Registry。

`project_self_memory_save` 不接受人物参数，人物由当前 WeCom 私有映射决定。它只保存当前用户明确陈述的原句，并生成私有证据回执、`human_statement` 来源和追加式审计。城市、时区、能力等未明确陈述的扩展不得自动写入。

写入工具必须返回结构化成功回执：`ok: true`、`status: created|duplicate`、`memory_id` 和 Workspace 相对 `file_path`。Hermes 只有在收到并通过校验的成功回执后，才能向用户说“已记下”“已写入”或“已更新人物画像”。工具失败、回执缺失、状态未知或文件不存在时，必须明确说明“本轮没有写入 Memory”，不得使用写文件工具绕过 Registry。

当前消息原文校验允许 Unicode、空白和标点归一化，但不允许补充原消息中没有出现的事实。失败回执只记录错误代码，不把 stderr、绝对路径或事实正文发送给模型或用户。

### Correction Task 闭环

人类明确指出 Hermes 的错误后，先创建一个 `task_kind: correction` 的父 Task，并将其加入常驻 Topic“Hermes 纠错与持续改进”。每个纠正都必须有一张 Task Card；父 Task 负责协调，Manager Review 或工程实施使用子 Task 跟踪。

运行时使用受控工具 `project_correction_task` 创建父 Task；不要用 `write_file` 手工创建纠错记录。只有目标已经修改并完成验证后，才使用 `project_correction_confirm` 创建 active Correction Memory。创建 Task 不等于纠正已经生效。

只有在正确行为已经应用到目标 Memory、Action Guide、Policy、项目规则或实现，并通过验证后，才可以创建 active Correction Memory。Correction Memory 必须链接 `correction_id`、`task_id`、`task_card_id`、`target_refs`、`applies_to_actions` 和 `source_refs`。待确认、未实施或被拒绝的纠正只保留在 Task，不得进入可检索事实。

Correction 不能覆盖更高优先级的 `03-decisions/`、Security Policy 或 L3 硬禁止。发生冲突时交给当前 Manager，并保留原 Correction Task 和审计记录。
