# 自动化单元（systemd user units）

模板提供最小自动化集：每日 ingestion 与每日公开投影发布。安装方式：

```bash
cd system
./install.sh /full/path/to/your/workspace
systemctl --user daemon-reload
systemctl --user enable --now collab-ingest.timer collab-publish.timer
```

单元以 `collab-` 前缀命名，避免与其他项目冲突；`install.sh` 会把 `__WORKSPACE__` 占位符替换为实际路径后安装到 `~/.config/systemd/user/`。

## 单元清单

| 单元 | 触发 | 作用 |
|------|------|------|
| `collab-ingest.timer` | 每日 09:00 | `hermes-human-event-reconcile.mjs --full-ingest`：inbox 认领 → 分类 → Event/卡片 → 任务 |
| `collab-publish.timer` | 每日 01:00 | `publish-workspace.mjs --full`：重建公开投影与版本 |

## 可选扩展（部署侧自带，不在模板内）

- 任务派发：监听 `09-tasks/dispatch_queue.json` 的 path 单元 + AgentRelay worker。
- 每日计划 / 状态报告：worker 侧 daily-planner / daily-status-reporter。
- inbox 实时响应：`project-hermes-card-reconcile.path` 模式的 path 触发器。

环境变量（写进单元的 `Environment=` 或 `~/.config/environment.d/`）：
`COLLAB_WORKSPACE`、`PROJECT_HERMES_COMMAND`、`COLLAB_PUBLIC_BASE_URL`、
`PROJECT_HERMES_EXTRACTION_MODEL` / `ROUTING_MODEL` / `DECISION_MODEL` / `FALLBACK_MODEL`。
