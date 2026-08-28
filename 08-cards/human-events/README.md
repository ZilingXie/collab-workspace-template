# 交流记录入库

交流记录表示人与人之间的交互，不等同于项目议题。内部仍使用 Human Event / `human_event_id`，不迁移数据字段。

将正式会议 transcript 放入：

```text
08-cards/human-events/inbox/meetings/
```

将聊天记录放入：

```text
08-cards/human-events/inbox/chat/
```

在企业微信群中明确 `@bot 入库聊天记录` 并上传一个受支持的文本或文档附件时，Analysis Package v2.1 Writer 会把不可变原件私有归档，并将 JSON pointer 排入该目录。PDF、Word、PowerPoint、Excel、Outlook、HTML、CSV、JSON、XML 先由本机 MarkItDown 转成标准 Markdown。同一 `run_id + attachment` 的工具重试不会重复排队。普通群消息、普通附件和私聊不触发该流程。

收到 Chat Inbox 文件后，Project Hermes 会立即：

1. 创建交流记录。
2. 生成 Hermes Personal Card，只记录 Hermes 对本次交流的总结。
3. 从交流记录材料中提炼候选 Topic 和 Task，但候选只进入内部 Review 数据。
4. 创建 Zac/Vivi Personal Card 提交任务。

每天 09:00，Project Hermes 还会检查 Zac/Vivi Draft Inbox，将未绑定材料路由到 Human Event 或 Topic，生成正式 Personal Card；无法判断的材料进入 clarification review。

Card Submission、Clarification 和普通 Task 创建后立即进入唯一 Dispatcher；Personal Card 的 72 小时窗口从实际 AgentRelay 派发时间开始。工作日 10:00 只发送未完成 Task 的提醒/状态日报，不创建或重复派发任务。

Analysis 派生内容写盘前脱敏；Raw 与 Analysis 不生成公开 URL。Candidate 必须携带可定位到原文行号的验证证据，缺少证据或正式 Task 必需字段时进入 Review。Human Event 的 `participants` 只包含人类；ShadowZac 归为 Project Hermes Agent，ToDos 归为通知机器人。

Meeting 和 Chat 进入交流记录后走同一套流程。Zac/Vivi 两张人类卡收齐后立即总结；未收齐时在实际派发时间起 72 小时到期后立即生成不完整总结。派发前已提交的有效卡片直接归档，不重复派发。09:00 管线会补偿遗漏的文件事件或 Relay 过期事件。

页面展示关系固定为：交流记录展示最多三条摘要、收敛后的项目议题标题链接、确认任务和交流记录 Personal Cards；收敛前不展示候选 Topic/Task。项目议题聚合展示项目议题摘要、明确带 `topic_id` 的 Topic Personal Cards 及其 Tasks / Task Cards。仅有交流记录关系的 Personal Card 不作为项目议题子卡片重复展示。原始附件在交流记录卡右上角以“原始记录”提供下载。

## Personal Card 摘要

Zac/Vivi 提交完整 Artifact，由 Hermes 在验收通过后生成正式 Personal Card。Hermes 使用完整 Artifact 生成一句话摘要，必要时最多三条 `key_points`；模型不可用时从原文的判断、结论和下一步段落兜底。Card 保留完整 Artifact，`card_id` 与 `content_id` 对应，并通过 `placement_type` / `placement_id` 记录主归属。

## 模型路由

- DeepSeek V4 Flash：Analysis Package v2.1、Human Event 初始摘要与候选 Topic/Task、Draft Inbox 归属路由。
- DeepSeek V4 Pro：最终 Human Event 总结、Topic/Task 共识、L2 候选、冲突与不确定归属、Task 验收。
- Flash 输出无法解析、引用不存在或需要判断时自动回退 Pro；L3 始终禁止。
- ID、文件移动、索引、HTML 渲染、AgentRelay 派发和 Task 状态更新由确定性代码执行。

- 两张人类卡都存在：双方一致，或一方确认且另一方没有反对的项目可以落地。
- 只有一张人类卡：只落地该卡明确确认且没有矛盾证据的项目。
- 没有人类卡：不落地任何 Topic/Task，全部候选项进入 Zac Review。
- 明确冲突、明确否决、无人确认或 Hermes 无法判断的项目进入 Zac Review。
