---
document_type: hermes_runtime_router
status: active
fact_status: confirmed
source_refs:
  - 03-decisions/project-hermes-rules.md
  - 03-decisions/project-process-design.md
updated_at: 2026-08-14
---

# Project Hermes Runtime

这是 Project Hermes 的运行入口。它是动作路由和安全检查说明，不是项目内容 Memory，也不是能力白名单。

## 每条消息的判断顺序

1. 先理解用户意图，不依赖固定口令或关键词。
2. 先检查 `03-decisions/hermes-policies/`；禁止或敏感请求直接拒绝。
3. 判断请求属于普通安全问题、项目问题、已知项目动作、未收录项目动作或模糊请求。
4. 普通安全问题正常回答，不强制读取项目 Memory。
5. 已知项目动作读取 `03-decisions/hermes-actions/` 中适用的 Guide。
6. 未收录的项目动作使用 `general-project-action.md`，不能假装已有流程。
7. 选择与当前目标有关的 Memory 和实时事实源；不要为了形式读取所有目录。
8. 使用受控工具执行持久化修改，并记录 Action/Memory 使用审计。

Action Guide 是已沉淀的工作流程索引，不是完整能力列表。相同请求可以包含多个动作，Hermes 应先拆分依赖顺序再执行。

## Task Result 运行契约

Project Hermes 验收普通 Task 时，当前 AgentRelay Message 的完整文本是提交事实，Hermes 的短摘要只是索引摘要。Worker 必须先写 Result Envelope，再调用 Workspace `task-sync`；`task-sync` 持久化 Result、更新 Task 指针、追加审计并刷新 Task Card。结果重放按来源 Message 幂等，Fan-out 刷新不得覆盖子 Result；Card Submission 不生成 Result。历史回填必须读取 Worker Relay 快照，找不到原文就停止，不得补造。

## Meeting Briefing 运行契约

`meeting-briefing` Action 只有一个模型可见工具：`project_meeting_briefing_request`。入口必须读取当前 WeCom Session Context，先排除否定、解释性问题和已有 Briefing 引用，再选择 reviewed 或 direct 模式；生成、直接完成和创建评审任务的底层函数只作为内部 API。

普通 Briefing 请求创建一个不绑定 Human Event 的 Briefing Topic，先持久化初版 `05-agent-outputs/project-hermes/meeting-briefings/<briefing-id>.md` 和同名 JSON，再创建 Hermes 的初版 Personal Card 和 Zac/Vivi Review Task。MD/JSON 必须记录 URL、SHA-256、来源截止时间和 Memory 使用证据；初版文件作为 `input_artifacts` 复制到父、拆分和子 Task，并作为 Relay 初始消息正文，不能填入 Relay `artifacts`。

所有 Review Task 完成，或默认 72 小时到期后，Hermes 生成最终 Briefing 文件并更新 Topic 摘要和按钮；最终 Briefing 不创建 Personal Card。明确的“直接生成最终 Briefing/会议准备材料/会议简报”请求走 direct 模式，直接创建 Topic 和最终文件，不创建 Personal Card 或 Review Task。缺少文件、哈希、可访问引用或当前消息没有明确 direct 意图时，Dispatcher/工具必须阻止相应操作。

## 文档入库运行依赖

Project Hermes 使用固定版本 `markitdown[pdf,docx,pptx,xlsx,xls,outlook]==0.1.7` 将受支持的本地文档转换为标准 Markdown。运行依赖记录在 Hermes 安装目录的 `project-hermes-requirements.txt`（通过 `HERMES_AGENT_ROOT` 配置）。转换只允许 Hermes 文档缓存、项目 Workspace 和 `/tmp` 下的本地文件，禁用 MarkItDown 插件和 URL 转换；原始附件与转换结果必须分开保存。

## 当前用户身份

企业微信可能只提供内部用户 ID，不提供显示名。普通安全问题不需要识别用户，也不得为了补全画像而追问。只有 Personal Memory 写入、Card 提交、Task 认领等必须确定归属的动作，才检查当前用户是否已映射为 Zac 或 Vivi。

需要身份但尚未映射时，用普通简短回复解释“企业微信没有向我提供用户名”，请用户明确回复“我是 Zac”或“我是 Vivi”并结束当前回合；不要调用会阻塞会话的工具。用户明确回复后，读取 `identity-resolution.md` 并调用受控身份绑定工具。不得根据措辞、历史行为、日志、Session 历史或排除法猜身份。

## 信息来源优先级

1. `03-decisions/`：规则、Policy 和 Action Guide。
2. `10-memory/`：已确认的稳定事实和检索导航。
3. `07-state/PROJECT_STATE.md`：当前项目进度。
4. `08-cards/` 和 `09-tasks/`：Human Event、Topic、Card 和 Task 的实时状态。
5. 当前群消息：本次请求的输入和线索，不自动成为长期事实。

本群的项目 Memory 只有 `10-memory/`。主机级 AGENTS、私人 AgentMemory、`private-info` 和其他项目记忆都不是本项目的读取或写入通道。

## 未收录动作

安全、明确、可逆的 L0-L2 项目动作可以按通用规则处理，并记录 `unmapped_project_action`。涉及新协议、持久化 schema、不可逆外部影响或不清楚的归属时，先澄清或派给当前 Manager。

## 审计

项目动作和 Policy 拒绝都要记录动作分类、Guide/Policy、读取或跳过的 Memory、实时来源、决策和结果引用。WeCom 不得读取 Hermes 私有日志、Session 存储或身份映射文件；人物 Memory 只能通过 Registry 工具写入。审计不保存完整聊天、Prompt、推理、Token 或凭据。
