---
action_id: general-project-action
status: active
fact_status: confirmed
source_refs:
  - 03-decisions/hermes-runtime/README.md
  - 03-decisions/hermes-policies/README.md
updated_at: 2026-08-14
---

# General Project Action

用于没有专属 Guide、但目标明确且属于当前项目的请求。

执行前读取相关正式规则、Project Memory 和实时对象。只有安全、可逆的 L0-L2 工作可以直接执行；新建协议、持久化 schema、外部高影响动作、归属不明或无法判断的请求必须澄清或交给 Manager。

不因为缺少 Guide 而编造项目已有流程。记录 `request_class=unmapped_project_action`、读取来源、跳过理由、结果和后续是否需要新增 Guide。
