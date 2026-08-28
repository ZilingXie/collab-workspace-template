---
memory_id: memory-navigation
memory_type: navigation
status: active
fact_status: confirmed
evidence_type: authority_pointer
source_refs:
  - 03-decisions/project-hermes-rules.md
  - 03-decisions/project-process-design.md
updated_at: 2026-08-12
---

# Project Hermes Memory

这是“成熟的AI要自己进化”项目的文件式长期记忆导航。Memory 保存稳定事实、项目语境和已确认共识；Session 历史不是事实源。

## 目录

| 目录 | 用途 | 读取时机 |
|---|---|---|
| `people/` | 人物画像和独立的明确人物事实 | 给某人派任务、解释协作分工 |
| `dictionary/` | 项目语境下的术语定义 | 遇到专有名词或歧义词 |
| `project/` | 项目身份、别名、入口和事实源导航 | 询问“这个项目是什么/现在在哪” |
| `consensus/` | Human Event 已确认的共同结论 | 回答双方已经达成的共识 |
| `methods/` | Human Event 收敛后确认的可复用方法 | 回答“以前怎么处理/这类问题怎么做” |
| `corrections/` | 人类纠正 Hermes 后的修订记录 | 修正错误回答或旧 Memory |

## 场景化调用

- 会议前 Briefing 读取人物、共识、方法和纠正，并从实时索引生成“当前进度”“参与者进度”和最多两个“建议主题”。参与者进度来自 accepted Personal Card、Task、Topic 和 Human Event，不从人物画像推测。
- 解释群聊中被引用的话时，读取请求者/表达者人物画像、项目字典、已确认共识；只有调用方明确提供 Human Event 或 Topic ID 时，才补充对应动态上下文。
- 每次调用都有 `usage_id`。可公开查看的聚合索引是 `memory-usage-index.json`，详细审计在 `.hermes/audit/memory-usage.jsonl`，均不保存完整 prompt、推理或聊天正文。

## 事实边界

- `09-tasks/task_index.json` 和对应 Task Card 是任务状态的唯一事实源；Memory 不复制动态状态。
- `07-state/PROJECT_STATE.md` 是当前项目进度的压缩事实源。
- `03-decisions/` 是正式规则和项目边界的最高事实源。
- `memory-candidates` 只是候选，不会自动进入本目录。
- `method_candidates` 只是候选；只有 Human Event 收敛且有 Zac/Vivi Card 支持才进入 `methods/`。
- 没有明确证据、来源或确认状态的内容禁止写入 Memory。
- 不能确定时，Hermes 必须说“未定义/待确认”，不能用常识补全。

## 写入方式

新建或修改 Memory 必须通过 `scripts/memory-registry.mjs`，并保留 `source_refs`、`evidence_type` 和追加式审计。旧结论被修正时使用 `supersedes`，不直接删除历史。

`people/<person>.md` 是角色与任务边界画像；`people/facts/<person>/` 保存独立的 `person_fact`。企业微信群的人物事实只能由确定性身份映射驱动的受控工具写入，不能直接编辑画像文件。

`session-notes/` 保留为历史 Analysis v1 档案，不是当前入库入口，也不是默认事实源。

推测、候选、临时总结、`need_review` 和缺少来源的内容不能进入 Memory。解释器可以输出歧义和澄清问题，但不得把解释结果自动提升为长期记忆。

人类明确纠正 Hermes 后，先在常驻 Topic“Hermes 纠错与持续改进”下创建一个 Correction Task 和 Task Card。纠正完成并通过验证后，才创建 `10-memory/corrections/records/` 中的 active Correction Memory；未完成或待 Review 的纠正只保留在 Task，不作为事实使用。Correction Memory 记录原行为、正确行为、适用 Action 和已更新目标，并通过 `supersedes` 保留版本链。
