---
action_id: ingest-conversation
status: active
fact_status: confirmed
source_refs:
  - 03-decisions/project-process-design.md
  - 03-decisions/project-hermes-rules.md
  - 03-decisions/hermes-policies/workspace-boundary.md
updated_at: 2026-08-14
---

# Ingest Conversation

适用于用户要求归档会议记录、聊天记录、transcript 或上传材料并沉淀到项目。

读取标准文本和本动作规则后，调用 `txt_dialogue_analysis_v2_save`，生成 Analysis Package v2.1。PDF、Word、PowerPoint、Excel、Outlook、HTML、CSV、JSON、XML 先由本机 MarkItDown 转为 Markdown，同时保留原始附件。分析必须区分事实、推测、未知和候选；候选不能绕过交流记录收敛直接变成 Topic、Task 或 Memory。

当前流程只接受一个受支持的文本或文档附件。保存成功后由 Chat Inbox 和 Human Event Pipeline 继续创建交流记录、Hermes Personal Card、卡片提交任务和后续收敛。不要将原文写入 Memory，不要直接修改项目状态。

完成标准是受控工具返回成功的 ingest pointer；没有 pointer 时报告失败，不把模型回复当成成功证据。
