---
action_id: identity-resolution
status: active
fact_status: confirmed
source_refs:
  - 03-decisions/hermes-runtime/README.md
  - 03-decisions/hermes-policies/workspace-boundary.md
updated_at: 2026-08-14
---

# Identity Resolution

只在当前动作必须确定人物归属时使用，例如写入人物 Memory、提交 Personal Card、认领或验收某人的 Task。天气、一般知识和不涉及归属的项目问题不检查身份、不要求用户自我介绍。

如果运行时身份上下文明确显示 `status: resolved` 和 `person: Zac/Vivi`，直接使用该身份。如果显示 `status: unknown`，普通回复：企业微信没有向 Hermes 提供用户名，请用户明确回复“我是 Zac”或“我是 Vivi”；随后结束本回合，不调用会阻塞会话的工具。

只有当前用户消息明确说“我是 Zac”或“我是 Vivi”时，才能调用 `project_identity_bind`。绑定工具会再次验证当前消息，不接受模型根据历史生成的身份参数。不得按表达习惯、历史行为、任务内容或“群里只有两个人”用排除法推断。已有绑定与新自报冲突时不覆盖，进入 Manager Review。

身份映射只保存在 Hermes 私有运行目录，不写入公开 Workspace、Card、Memory、页面或普通审计正文。绑定成功后可以继续处理上一条需要归属的动作，但必须再次经过受控写入工具校验。
