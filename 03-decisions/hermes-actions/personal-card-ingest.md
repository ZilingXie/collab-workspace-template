---
action_id: personal-card-ingest
status: active
fact_status: confirmed
source_refs:
  - 03-decisions/project-process-design.md
  - 03-decisions/project-hermes-rules.md
updated_at: 2026-08-14
---

# Personal Card Ingest

读取 `human_event_id` 或 `topic_id` 明确归属、Inbox 作者目录和 Artifact 内容。Zac/Vivi 的 Artifact 由 Hermes 验收并生成随机 Card ID、Content 和最多三条摘要。

同一作用域、作者和相同内容进入 quarantine；不同内容形成 revision。旧 accepted Card 保留为历史版本，不作为普通展示卡片。
