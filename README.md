# collab-workspace-template

一套「人和 Agent 共享 workspace」的协作协议框架：材料进入共享空间 → 被索引成 Human Event / Card / Topic → 压缩成任务与状态 → 人类用自然语言纠正 → 纠正沉淀为规则和长期记忆。本模板从 [一个真实运行的试点](docs/protocol.md) 中抽取，包含全部流水线脚本、看板、协议文档和一键初始化。

数据与框架分离：**这个 repo 只有框架，没有数据**。每个项目用 `bin/init.mjs` 生成自己的私有 workspace（目录 + git + 配置），框架脚本以 vendored 副本随 workspace 走。

## 快速开始

```bash
git clone https://github.com/ZilingXie/collab-workspace-template.git
cd collab-workspace-template
node --test scripts/test/        # 应全绿（78 个用例）

# 初始化一个新项目 workspace
node bin/init.mjs ~/projects/my-project --title "我的项目" --participants alice,bob --manager Alice
cd ~/projects/my-project

# 丢材料（或由消息入口自动投放）
echo "# 会议记录..." > 08-cards/inbox/alice-draft/2026-01-01-meeting.md

# 跑流水线（需要 Hermes CLI，见 docs/deployment.md）
node scripts/hermes-09-ingest.mjs

# 发布公开投影（版本化数据，供 workspace.html 消费）
node scripts/publish-workspace.mjs --full --reason first-run
```

## Agent 八问（装完即用的入口）

安装本框架的 workspace 里，Agent 应能只靠文件回答以下问题：

| 问题 | 答案入口 |
|------|----------|
| 我是谁、为谁工作 | `03-decisions/project-roles.json` |
| 材料丢哪里 | `08-cards/inbox/<participant>-draft/` |
| 当前状态看哪里 | `07-state/PROJECT_STATE.md` → `09-tasks/task_index.json` → `08-cards/card_index.json` |
| 事实源优先级 | `03-decisions/` > `07-state/` > README > 群聊消息（只作线索） |
| 怎么纠正错误 | 自然语言纠正 → `06-pdca/failure-examples.md` → 稳定后升为 `03-decisions/` 规则 |
| 任务怎么来 | Human Event 收敛 → Topic/Task → `09-tasks/`（注册表 + 派发队列） |
| 哪些动作被禁止 | `.hermes/l3-policy.json`（L3 硬禁止，代码级拦截） |
| 什么不能公开 | `scripts/publish-workspace.mjs` 的公开投影白名单；拿不准就不公开 |

## 目录地图（init 生成后的 workspace）

```
01-raw/       原始材料（私有）
02-notes/     脱敏结构化分析
03-decisions/ 规则与协议（含 hermes-actions/policies/runtime）
04-reports/   报告
05-agent-outputs/ 各 agent 产出
06-pdca/      失败样例与纠正闭环
07-state/     状态卡 PROJECT_STATE.md + 索引
08-cards/     inbox → Human Event → Card/Topic 的主战场
09-tasks/     任务注册表（task_index.json）+ 派发队列
10-memory/    文件式项目记忆（people/project/consensus/corrections）
public-data/  公开投影（版本化，workspace.html 的数据源）
scripts/      流水线引擎（本框架的核心）
workspace.html 本地看板
```

## 核心链路

```
inbox 材料投放
  → scripts/hermes-card-ingest.mjs      分类：human_event 绑定 / 归档 / review
  → scripts/hermes-draft-router.mjs     草稿路由
  → scripts/human-event-pipeline.mjs    Human Event 收敛 + Review + 卡片收集
  → scripts/task-registry.mjs           Topic/Task 创建（09-tasks/）
  → 派发（AgentRelay，见 docs/deployment.md）
  → scripts/task-sync.mjs               结果回收
  → scripts/publish-workspace.mjs       公开投影 + workspace.html
```

每天 09:00 定时 ingestion、01:00 发布，由 `system/` 的 systemd 单元驱动。

## 配置（环境变量）

| 变量 | 作用 | 默认 |
|------|------|------|
| `COLLAB_WORKSPACE` | workspace 根目录 | 脚本所在目录的上一级 |
| `PROJECT_HERMES_COMMAND` | Hermes CLI 命令 | `hermes`（PATH 查找） |
| `COLLAB_PUBLIC_BASE_URL` | 公开投影的绝对 URL 前缀（如 `https://example.com`） | 空（用相对路径） |
| `HERMES_AGENT_ROOT` | Hermes 安装目录 | `~/.hermes/hermes-agent` |
| `PROJECT_HERMES_CARD_MAX_TURNS` 等 | 模型调用预算 | 见 docs/deployment.md |

## v1 已知边界

- **双参与者惯例**：流水线沿用试点项目的两位参与者约定（`zac` / `vivi` 及其 agent id），在 `03-decisions/project-roles.json` 中登记。改名字大部分场景可用，但 `human-event-pipeline` 的卡片收集循环和 briefing 默认值仍按双参与者写死；多参与者泛化在 roadmap。
- **派发 worker 不在本模板**：任务通过 AgentRelay 派给个人 agent 的常驻 worker（listener/dispatcher）属于部署侧私有组件，未包含在 v1。没有 worker 时任务照常创建入队，可用 `09-tasks/dispatch_queue.json` 对接你自己的派发器。
- 模型分类依赖 Hermes CLI（`PROJECT_HERMES_COMMAND`）；无模型时空提交/无归属材料会进 review 而不是失败。

## License

MIT
