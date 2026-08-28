---
action_id: meeting-briefing
entry_tool: project_meeting_briefing_request
model_allowed_tools:
  - project_meeting_briefing_request
internal_tools:
  - project_meeting_briefing_generate
  - project_meeting_briefing_finalize_direct
  - project_meeting_briefing_review_create
status: active
fact_status: confirmed
source_refs:
  - 10-memory/retrieval-rules.md
  - 03-decisions/project-process-design.md
updated_at: 2026-08-14
---

# Meeting Briefing

会议前生成“当前进度”“参与者进度”和最多两个“建议主题”。读取当前 Human Event、活跃 Topic、Task 状态和 accepted Personal Card；按需要读取真人画像、共识、方法和纠正。Briefing Topic 本身暂不绑定 Human Event。

人物画像只用于角色和任务边界，不用于推断个人当前进度、能力或意图。建议主题必须有原因、期望结果和来源；证据不足时明确说明。

## 标准评审模式

Hermes 收到普通 Briefing 请求时，必须按以下顺序执行：

1. 创建一个新的 Briefing Topic，不绑定 Human Event。
2. 生成初版 Briefing，并先把完整文本写入：

```text
05-agent-outputs/project-hermes/meeting-briefings/<briefing-id>.md
05-agent-outputs/project-hermes/meeting-briefings/<briefing-id>.json
```

3. 创建一张 `author: Hermes`、`briefing_stage: draft` 的 Personal Card，立即挂到该 Topic。
4. 为每位参会人创建 Briefing Review Task，并把同一份 Briefing 作为 `input_artifacts` 传给父、拆分和子 Task。

JSON 必须记录 `briefing_id`、`topic_id`、`markdown_path`、公开 URL、SHA-256、来源截止时间和 Memory 使用证据。只有 MD/JSON 存在且哈希、必需章节和 URL 校验通过，Hermes 才能派发评审 Task。Relay 的 `artifacts` 只保留 Zac/Vivi 的评审产出，不能预填为 Briefing。

所有参会人评审 Task 完成，或默认 72 小时到期后，Hermes 读取初版 Briefing和评审快照生成最终 Briefing。最终文件保存在同一目录，Topic 只显示一句话摘要和可打开完整文件的按钮，不再生成最终 Personal Card。评审收敛必须保留每位参会人的完成/到期状态；未回复只能表示没有提出异议，不能伪造反馈文本。

## 直接生成模式

只有当前企业微信群消息明确表达“准备一个最终 Briefing”“直接生成会议准备材料”“无需评审”等意图时，入口才选择直接模式。该模式创建 Briefing Topic、直接持久化最终 MD/JSON 并更新 Topic 按钮，不创建初版 Personal Card，也不创建参会人 Review Task。仅调用工具参数不能替代当前消息中的明确意图。

## 受控工具

`project_meeting_briefing_request` 是本 Action 唯一允许模型调用的入口。它以当前 WeCom Session Context 为准，先排除否定、解释性问题和已有 Briefing 引用，再确定标准评审或直接模式。`project_meeting_briefing_generate`、`project_meeting_briefing_finalize_direct` 和 `project_meeting_briefing_review_create` 仅供入口工作流与测试内部调用，不进入模型工具集。缺少文件、哈希或可访问引用时 Dispatcher 阻止派发，不发送只有“请评审 Briefing”而没有 Briefing 正文的任务。

入口按 `request_message_id` 幂等，并记录 Guide、入口工具、工作流模式、Topic、Briefing 和最终产物引用。只有 Topic、MD/JSON、Card/Task 索引和公开投影均可解析后，才向群聊返回成功结果。

如果只能从历史 WeCom 消息恢复，使用固定的恢复脚本保存原文，不改写原始措辞，并明确标记 `generation_audit_status: unavailable`、`memory_usage_evidence: not_recorded_at_generation`；不得补造 Memory 因果证据。
