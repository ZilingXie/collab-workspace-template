# AGENTS.md — 在本 workspace 工作的 Agent 协议

你正在一个基于 collab-workspace-template 的共享 workspace 中工作。本文件是你与其他 Agent、与人类协作的协议摘要。完整规则见 `03-decisions/`，当前状态见 `07-state/PROJECT_STATE.md`。

## 身份与角色

- 角色定义在 `03-decisions/project-roles.json`：project_manager（治理者 Agent）+ participants（人类与其个人 Agent）。
- 个人 Agent 负责贡献（提交卡片、执行任务、写 agent output）；manager Agent 负责治理（索引、状态卡、PDCA、规则提升）。

## 材料

- 新材料投放：`08-cards/inbox/<participant>-draft/`（Markdown 最佳；支持文本/JSON/HTML）。
- 空文件、无归属材料会进入 `08-cards/review/` 等待人工决定，不要绕过。

## 事实源优先级（回答项目问题时）

1. `03-decisions/` — 已确认规则
2. `07-state/PROJECT_STATE.md` — 当前状态压缩版
3. `README.md` — 项目入口
4. `02-notes/` `04-reports/` — 整理产物
5. `01-raw/` — 原始材料
6. 群聊消息 — 只作线索，不作权威

回答要求：**能给路径就给路径；不确定标待确认；找不到就说找不到；答错写 PDCA。**

## 写东西放哪里

| 内容 | 位置 |
|------|------|
| Agent 产出 | `05-agent-outputs/<agent-name>/` |
| 任务结果 | 按 `09-tasks/tasks/<task-id>/results/` 约定写回，并回复派发消息 |
| 状态更新 | 只有 manager Agent 修改 `07-state/PROJECT_STATE.md` |
| 失败/纠正 | `06-pdca/failure-examples.md`（现象/根因/修正/沉淀 四段式） |

## 硬边界（L3）

`.hermes/l3-policy.json` 定义代码级拦截的硬禁止动作（不可逆数据破坏、凭据变更、生产操作、外发等）。派发器在执行前检查；被拦截就是拦截，不要尝试绕过或拆步绕过。

## 公开与私有

`scripts/publish-workspace.mjs` 按白名单生成 `public-data/` 公开投影。默认私有：`01-raw/` 原文、`08-cards/processing|review/`、任务队列、`.hermes/` 运行时。**拿不准是否可公开时，不公开。**

## 长期记忆

稳定、被人类确认过的共识写入 `10-memory/`（people / project / dictionary / consensus / corrections 分类），没有来源的推测、候选或未确认内容禁止写入。
