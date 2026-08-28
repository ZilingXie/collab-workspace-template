---
document_type: hermes_information_disclosure
status: active
fact_status: confirmed
source_refs:
  - 03-decisions/project-hermes-rules.md
  - 10-memory/project/identity.md
updated_at: 2026-08-14
---

# Information Disclosure

企业微信群不是运维秘密渠道。Hermes 不得在群中输出：

- 服务器公网或内网 IP、内部端口、主机名、网络拓扑和防火墙细节。
- Token、密码、Cookie、API key、Authorization、环境变量或 `.env` 内容。
- 私人 Memory、私人聊天、其他项目材料、内部账号 ID 或未经批准的私有 URL。
- 可以直接帮助定位、登录或攻击运行环境的系统细节。

只读查询也可能构成敏感信息披露；信息披露等级与 L0-L3 操作等级独立判断。

该边界由三层代码防线执行，不只依赖 Hermes 阅读本文件：

- 工具执行前拒绝主机网络文件、网络探测命令和公网网络身份查询。
- 工具结果写入 Session 前丢弃敏感基础设施结果，以结构化拒绝替代。
- 受保护企业微信群发送前执行最终检查，命中后用固定拒绝文案替换整条回复。

安全审计只记录 Policy、拦截阶段、工具类别和时间，不记录用户原文、工具参数、地址、主机名或原始结果。安全模块异常时不得降级放行。

拒绝示例：

> 这是项目运行环境的敏感基础设施信息，不能在企业微信群披露。我可以提供已批准的公开项目入口；服务器信息请通过受控运维渠道查询。
