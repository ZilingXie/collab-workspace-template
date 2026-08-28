# 协议总览：材料如何变成记忆

本框架的核心是一条可审计的收敛链路。每个环节都有磁盘上的事实源，人和 Agent 都能离线读。

## 1. 材料入库（Ingestion）

```
08-cards/inbox/<participant>-draft/xxx.md
  → 08-cards/processing/ing-<id>/intake.json     # 认领（attempts / status 状态机）
  → 分类（Hermes 模型调用）：
      human_event 绑定 → 直接归档进既有 Event
      create/link      → 新建/关联旧式 Event
      review           → 08-cards/review/<owner>/<ing>/review.json + card_validation_review 任务
      ignore           → 08-cards/legacy/ignored/
```

守卫：空提交（0 字节）不调用模型，直接进 review；同一材料重复提交按 content_hash 幂等；孤儿 review（有 review.json 无任务）在每次运行时自动补建任务。

## 2. Human Event（交流记录的最小单元）

`08-cards/human-events/records/he-<id>/`：

- `event.json` — 标题、参与者、摘要、候选 Topic/Task（`pending_human_review` → `materialized`）
- `review.json` — 收敛状态机（`pending_cards` → 卡片收集 → `finalized`）
- `sources/` — 原始材料归档
- `review-task.json` — 派给参与者的 Review 任务

切片原则：**按事件切片，不按自然日切片**。会议、一次群聊讨论、一份递交都是 Event。

## 3. Personal Card（每个参与者对 Event 的视角）

每个 Event 期望 manager + 各参与者各交一张卡（`08-cards/cards/card-<id>.md`，frontmatter 带 `human_event_id` / `author` / `lifecycle_status`）。卡片必须包含对候选 Topic/Task 的确认、修改、反对或补充——这是共识的证据链。同作者内容变更产生 revision（旧卡 superseded）；重复提交进 quarantine。

## 4. Topic 与 Task

Event 收敛（Review finalize 或无异议到期）后：

- Topic：`08-cards/topics/topic-<id>/topic.json`，聚合相关 Event 与卡片
- Task：`09-tasks/tasks/task-<id>/task.json`（注册表 `task_index.json` + 派发队列 `dispatch_queue.json`）
  - 状态机：`ready → dispatching → processing → completed | expired | cancelled`
  - `card_submission` 有自己的收集截止；`fanout_child` 跟随父收集任务
  - 过期治理：派发后超过 due（或无 due 超 14 天）由派发器 sweep 收敛，写 `expired_overdue_dispatch` 审计

## 5. 纠正与 PDCA

人类用自然语言纠正（"这里不对，应该是…"）→ 写入 `06-pdca/failure-examples.md`（现象/根因/修正/沉淀）→ 稳定规则提升到 `03-decisions/`。**人类说"没懂 / 太抽象"本身就是 PDCA 触发器。**

## 6. 记忆

`10-memory/`：people（人物画像）/ project（项目身份）/ dictionary / consensus（已确认共识）/ corrections（纠正史）/ methods。只有被人类确认、有来源的内容才能进；候选与推测留在 Event/Card 层。

## 7. 公开投影

`publish-workspace.mjs` 按白名单把 project/cards/tasks/files/people/process/memory 打成版本化 JSON，`workspace.html` 消费。原文与运行时目录永不进投影。

## 8. 安全边界（L3）

`.hermes/l3-policy.json` 定义硬禁止动作（不可逆破坏、凭据、生产、外发、法务/隐私、治理绕过、自动化扩散），派发前代码级评估，命中即拒 + 审计。
