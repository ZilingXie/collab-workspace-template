# 部署指南

## 依赖

- Node.js ≥ 20（脚本仅用标准库，无 npm 依赖，无 package.json）
- Hermes CLI（材料分类用的模型调用入口），通过 `PROJECT_HERMES_COMMAND` 指定；没有它时流水线仍可运行，但分类会退化（无归属材料进 review）

## 环境变量

| 变量 | 作用 | 默认 |
|------|------|------|
| `COLLAB_WORKSPACE` | workspace 根目录 | 脚本所在目录上一级 |
| `PROJECT_HERMES_COMMAND` | Hermes CLI | `hermes` |
| `COLLAB_PUBLIC_BASE_URL` | 公开绝对 URL 前缀 | 空 = 相对路径 |
| `HERMES_AGENT_ROOT` | Hermes 安装目录（runtime 校验用） | `~/.hermes/hermes-agent` |
| `PROJECT_HERMES_CARD_MAX_TURNS` / `_TIMEOUT_MS` | 单次分类的轮次与超时 | 4 / 600000 |
| `PROJECT_HERMES_CARD_MAX_SOURCE_CHARS` | 单材料截断长度 | 60000 |
| `PROJECT_HERMES_EXTRACTION_MODEL` 等 | 模型选择（flash 提取 / pro 决策） | 部署自定 |

## 定时自动化

见 `system/README.md`（ingest 09:00 + publish 01:00）。

## 公开投影与 Nginx

`publish-workspace.mjs` 生成：

```
public-data/manifest.json          # 当前版本指针
public-data/versions/<hash>/*.json # 不可变版本数据集（project/cards/tasks/files/people/process/memory）
```

`workspace.html` 相对引用 `public-data/`，放在任意静态站点子路径下即可（试点部署在 `/collaborate/` 子路径）。Nginx 侧只需要：

```nginx
location /collaborate/ {
    alias /srv/collab-workspace/;   # 或 workspace 根目录，建议只暴露白名单内容
    add_header Cache-Control "no-cache";
}
```

⚠️ 公开部署前确认 `.gitignore` 的运行时目录、`01-raw/` 原文不在暴露范围内；`publish-workspace.mjs` 的白名单（`publicReference()`）是代码级防线，nginx 别把整个 workspace 根直接裸露。

## 任务派发（AgentRelay，可选）

任务创建后进入 `09-tasks/dispatch_queue.json`（`pending` → `dispatched` → 终态）。本模板不含常驻 worker；对接方式：

1. 部署一个 AgentRelay 实例；
2. 写一个轮询/监听 `dispatch_queue.json` 的派发器（参考试点实现：读队列 → L3 检查（`scripts/l3-policy.mjs` 的 `assertL3Allowed`）→ POST 到 AgentRelay → 回写状态）；
3. 结果回收参考 `scripts/task-sync.mjs` 的幂等约定。
