---
memory_id: memory-retrieval-rules
memory_type: retrieval_rules
status: active
fact_status: confirmed
evidence_type: authority_pointer
source_refs:
  - 03-decisions/project-hermes-rules.md
  - 03-decisions/project-process-design.md
updated_at: 2026-08-12
---

# Memory Retrieval Rules

| 用户问题/动作 | 必须读取 | 动态事实补充 |
|---|---|---|
| 给 Zac/Vivi 派任务 | 对应 `people/<person>.md`、`people/facts/<person>/`、相关共识 | `09-tasks/task_index.json`、Topic/Task |
| 解释项目术语 | `dictionary/terms.md` | 有冲突时读取 `03-decisions/` |
| 查询 Task 进度 | `project/context.md` 的事实源导航 | `09-tasks/task_index.json`、对应 `task.json` 和 Task Card |
| 询问这个项目是什么 | `project/identity.md`、`project/context.md` | `07-state/PROJECT_STATE.md` |
| 查询当前项目进展 | `project/context.md` | `07-state/PROJECT_STATE.md`、`09-tasks/task_index.json` |
| 询问双方共识 | `consensus/index.md` 和对应记录 | Human Event、Personal Card、Topic |
| 修正错误记忆 | `corrections/index.md` 和目标 Memory | 明确的人类纠正来源 |
| 纠正 Hermes 行为 | 当前 Action 适用的 active Correction Memory | 对应 Correction Task、Task Card 和目标文件 |
| 会议前 Briefing | 对应真人的 `people/`、`consensus/`、`methods/`、`corrections/` | `07-state/PROJECT_STATE.md`、`08-cards/card_index.json`、`09-tasks/task_index.json`、Human Event/Topic |
| 解释被引用的话 | 请求者和发言者的 `people/`、`dictionary/`、`consensus/`、`project/` | 仅使用明确提供的 Human Event/Topic ID 读取对应动态上下文 |

## 检索约束

1. 先按 ID 精确定位，再按同一 Topic 内的规范化标题定位；多个候选时列出候选，不能猜。
2. Memory 只说明稳定事实和去哪里找动态事实，不替代 Task、PROJECT_STATE 或原始证据。
3. 只有 `fact_status: confirmed` 的记录可以作为事实使用。
4. `proposed`、`candidate`、`unconfirmed`、`needs_review` 不能作为事实回答。
5. Hermes 不得把推测写成事实；推测不得写入 `10-memory/`，也不得通过改写措辞绕过校验。
6. Memory 与 `03-decisions/` 或其他更高优先级事实源冲突时，以高优先级事实源为准，并创建 correction。
7. WeCom 身份只有运行时的确定性私有映射或当前消息的明确自报可以建立；Session、日志、表达习惯和群成员列表都不是身份证据。
8. Correction Memory 只有在对应 Correction Task 完成、目标已应用且有验证来源后才为 active；`candidate`、`need_review`、`cancelled` 和 `superseded` 不能作为行为规则。
9. Correction 不能覆盖 `03-decisions/`、Security Policy 或 L3 硬禁止；发生冲突时以更高优先级规则为准，并创建新的 Correction Task。

## 会议前 Briefing

Briefing 的输出不是“上次聊到哪里”，而是可验证的“当前进度”：从最新 Human Event、活跃 Topic、Task 状态和已接受 Personal Card 生成。动态状态不写入人物画像或长期 Memory。

“参与者进度”只为本次 Briefing 汇总真人的动态记录，字段固定为：最近完成、当前推进、待确认或阻塞。来源优先级为：

1. 本人的最新 accepted Personal Card；
2. 本人负责的 Task/Task Card；
3. 关联 Topic；
4. 关联 Human Event；
5. 人物画像只说明角色和任务边界，不用于推断进度、能力或意图。

“建议主题”由当前最大未对齐点和项目进度生成，最多提出 1-2 个问题，并为每个问题提供原因、期望结果和来源。没有足够证据时输出“没有足够证据”，不强行补全。

## 引用消息解释

企业微信群中，Zac 或 Vivi 可以引用对方原话并明确 @Hermes 请求解释。解释器按以下顺序读取：

1. 请求者和原话表达者的人物画像，用于适配表达方式和识别角色边界；
2. `10-memory/dictionary/`，解释项目内术语，例如 Agora、RAG；
3. 已确认的 `10-memory/consensus/` 与 `project/`；
4. 只有入口明确提供 `human_event_id` 或 `topic_id` 时，才读取对应 Human Event、Topic 和 accepted Personal Card。

没有显式 ID 时，解释器不能依据文字相似度猜测历史事件。解释必须区分原话、已确认上下文、术语含义和歧义，不能替发言者补充未表达的结论，也不会自动创建 Card、Topic、Task 或 Memory。每次读取通过 `scripts/memory-context.mjs` 生成 `usage_id`，由 `scripts/memory-usage.mjs` 写入不含正文的使用审计。
