# 用户手册

日期：2026-08-12  
状态：当前协议  
维护者：Project Hermes  
关联：`project-hermes-rules.md`、`agentrelay-integration-rules.md`、`08-cards/README.md`、`09-tasks/README.md`、`10-memory/README.md`

本文档是“成熟的AI要自己进化”项目的用户手册。它描述人类材料如何进入共享 Workspace，如何形成交流记录、Personal Card、项目议题、Task 和 Task Card，以及 Project Hermes、AgentRelay、Zac/Vivi Agent 各自负责什么。内部仍使用 `human_event_id` 作为交流记录的稳定字段，不进行数据字段迁移。

> 页面展示以本文档为内容来源；运行事实仍以 `08-cards/card_index.json`、`09-tasks/task_index.json` 和实际服务状态为准。

<!-- process:overview|flow|confirmed -->
## 项目总流程

```text
人类交流 / 单份材料
→ 明确入库
→ Analysis Package v2.1
→ 交流记录
→ Hermes Personal Card
→ Zac / Vivi Personal Card
→ 交流记录收敛
→ 项目议题
→ Task 与 Task Card
→ AgentRelay 派发、执行和验收
→ workspace.html 展示
```

项目遵循“个人 Agent 负责贡献，Project Hermes 负责治理”的边界。AgentRelay 是传输、任务状态和审计层，不是项目事实源。

<!-- process:runtime|architecture|confirmed -->
## Hermes 动作运行架构

企业微信群只提供稳定的项目身份和 Workspace 入口。Hermes 根据用户意图理解请求，再依次检查 Policy、选择 Action Guide、选择相关 Memory 和实时事实源。Action Guide 是已沉淀流程索引，不是能力白名单；没有匹配 Guide 的安全、明确、可逆 L0-L2 项目动作使用通用项目规则，重复出现后再沉淀为新 Guide。

```text
WeCom 消息
→ Project Hermes 语义理解
→ hermes-policies/ 边界检查
→ hermes-actions/ 流程选择
→ 10-memory/ + 07-state/ + 08-cards/ + 09-tasks/
→ 受控工具执行
→ Action / Memory 使用审计
```

Gateway 和 Adapter 只负责传递正文、附件、引用和平台元数据，并保留当前聊天入库的兼容路径；它们不负责为每种自然语言新增动作关键词。L3、凭据脱敏、幂等、文件边界和持久化写入校验仍由代码保证。

运行入口：`03-decisions/hermes-runtime/README.md`；安全 Policy：`03-decisions/hermes-policies/`；动作流程：`03-decisions/hermes-actions/`。

<!-- process:ingest|flow|confirmed -->
## 聊天记录入库

触发必须同时满足：企业微信群、明确 `@Hermes 入库聊天记录`、上传一个受支持的文本或文档附件。普通群消息、没有明确指令的附件和私聊不触发。

当前支持以下格式入库：

- 文本：TXT、Markdown、LOG
- PDF：PDF
- Word：DOCX
- PowerPoint：PPTX
- Excel：XLSX、XLS
- Outlook：MSG
- 结构化文档：HTML、CSV、JSON、XML

1. 当前一次入库只接受一个附件。TXT、Markdown、LOG 直接读取；其余受支持格式使用 MarkItDown 0.1.7 在 Hermes 本机转换成标准 Markdown，再进入相同的 Analysis Package v2.1 流程。多附件或不支持的格式直接拒绝，不创建半成品。
2. 为本次材料生成稳定 `ingest_id`，原文不可变、私有写入 `01-raw/intakes/<ingest_id>/`，不生成公开 URL。
3. 非纯文本材料的标准 Markdown 写入 `02-notes/intakes/<ingest_id>/source.md`；Hermes 再生成 `analysis.json`，并自动渲染 `analysis.md`。
4. Analysis Package 只保存事实、推测、未知、风险和候选对象；候选不能直接成为正式事实。
5. Chat Inbox 只保存指向 raw、analysis 和 manifest 的 JSON pointer；指针变化后创建一个 `type: chat` 交流记录。
6. Hermes 生成只表达自身交流总结的 Personal Card，并在内部提炼候选 Topic、Task 和可复用方法。
7. 为尚未提交卡片的 Zac、Vivi 创建 `card_submission` Task，并立即通过唯一 Dispatcher 派发；工作日 10:00 只提醒未完成任务。
8. Zac/Vivi 卡片收齐后立即收敛交流记录；未收齐时从实际派发时间起 72 小时到期后收敛。

同一保存工具重试不会重复入库；用户再次发出明确入库指令视为一次新的 Human Event 输入。

<!-- process:analysis|catalog|confirmed -->
## 入库分析包 v2.1

每次单附件入库只生成一个 Analysis Package，而不是七份并列的长期文件。Raw 与 Analysis 都是内部材料，不进入文件视图公开清单：

```text
01-raw/intakes/<ingest_id>/
├── source.<ext>     原始材料，不修改并保留真实格式
└── manifest.json    来源、状态和 Human Event 关联

02-notes/intakes/<ingest_id>/
├── source.md        非纯文本材料经 MarkItDown 生成的标准文本
├── analysis.json    自动化唯一消费的结构化分析
└── analysis.md      从 JSON 渲染的人类阅读版本
```

`analysis.json` 包含以下内容：

| v2.1 内容 | 原七类产物来源 | 用途 |
|---|---|---|
| `signal_analysis` | `signal-filter` | facts、speculations、unknowns、risks、actions、noise |
| `human_event` | `events` 的唯一交互归属 | 这一份聊天记录对应的人类交互 |
| `topic_candidates` / `task_candidates` | `events` | Human Event 中讨论的主题和行动候选 |
| `person_candidates` | `personas` | 待确认的人物画像变化 |
| `dictionary_candidates` | `terms` | 待确认的项目术语 |
| `method_candidates` | `method-notes` / `sop` | 待 Human Event 收敛的可复用方法 |
| `decision_candidates` | `sop` | 待确认的正式规则修改建议 |
| `memory_proposals` | `memory-candidates` | 待确认的长期记忆候选 |

旧七类文件不删除，作为历史 Analysis v1 只读档案保留；新入库不再生成它们。`analysis.md` 只是 `analysis.json` 的渲染，不是第二个事实源。

Analysis Package 不能绕过 Human Event 收敛直接创建 Topic、Task、Decision 或 Memory。`events` 不再表示多个独立事件：一份聊天记录先创建一个 Human Event，聊天中讨论的内容再提炼为 Topic 和 Task。

所有候选必须有 `source_refs`。Hermes 必须明确区分事实、推测和未知；推测只能留在 `speculations` 或 `uncertainties`，禁止改写成事实。

所有派生文本在写盘前执行凭据脱敏，只保留不可逆短指纹用于审计，禁止在错误、日志、Card、Index 或页面中重复明文凭据。原文保持不可变，但使用私有权限；文件视图只通过显式白名单发布文件，不依据 Unix 可读权限推断公开状态。

每个 Candidate 应提供逐字 `evidence_quotes`。受控 Writer 只接受原文精确匹配或空白归一化匹配，写入 `source_ref`、起止行号和不超过 200 字的脱敏摘录；语义近似或无法定位时标记 `evidence_status: missing`。缺少已验证证据的 Topic、Task、Method、Decision 或 Memory 不得自动落地，必须等待 Card 收敛或进入 Review。

Task Candidate 分开保存原文状态 `source_status` 和候选流程状态 `candidate_status`，并将 `assignee` 规范为 `owner`。正式 Task 仍必须具备内容、Topic、Owner 和完成标准，缺失时标记为 `need_review` 并进入 Manager Review，不能生成半空 Task。

### Method 总结

`method_candidates` 在初始分析时产生，但只有 Human Event 收敛后，结合原始材料、Hermes Card、Zac Card 和 Vivi Card 才能判断：

- 可复用且有人类 Card 支持：写入 `10-memory/methods/`。
- 再次验证已有方法：追加来源，不重复创建。
- 明确修正已有方法：使用 `supersedes` 创建新版本。
- 一次性做法、证据不足或存在冲突：留在 Analysis 或进入 Review。

只有 Hermes Card 支持时，方法不能自动进入正式 Memory。

<!-- process:memory|architecture|confirmed -->
## 项目记忆

本项目使用文件式 Memory，不依赖 Session 历史，也不复制动态 Task 状态。Memory 目录为：

```text
10-memory/
├── people/       人物明确角色、协作偏好和任务匹配边界
├── dictionary/   项目语境下的术语定义
├── project/      项目身份和事实源导航
├── consensus/    Human Event 已确认的共同结论
├── methods/      Human Event 收敛后确认的可复用方法
└── corrections/ 人类纠正后的记忆修订
```

Hermes 按问题读取不同目录：派任务先读对应人物画像，解释术语先读字典，回答项目身份先读 project，回答共同结论先读 consensus；Task 进度仍实时读取 `09-tasks/task_index.json` 和对应 Task Card，当前进度仍以 `07-state/PROJECT_STATE.md` 为准。

### 企业微信身份与 Memory 归属

企业微信 AI Bot 回调可能只提供内部用户 ID。该 ID 与 Zac/Vivi 的绑定保存在 Hermes 私有运行目录，不进入 Workspace、页面、Card 或 Memory。普通问题不需要识别身份；只有人物 Memory 写入、Card 提交、Task 认领等必须确定归属的动作才检查映射。未知用户由 Hermes 用普通消息说明无法看到用户名并请其自我介绍，不使用阻塞式 `clarify`；只有用户明确自报后才能绑定，冲突绑定进入 Manager Review。

本群要求沉淀的项目协作事实统一写入 `10-memory/`。例如用户明确说“我的 base 在上海”并要求记住，确认身份后写入对应 `10-memory/people/`。主机级 AGENTS、私人 AgentMemory、`private-info` 和 Hermes 内置 Memory 与本群隔离，不是候选写入通道；旧聊天或历史材料提到它们不能覆盖当前规则。

### 会议前 Briefing 与引用解释

会议前 Briefing 使用 `scripts/briefing-workflow.mjs` 和 `scripts/generate-meeting-briefing.mjs` 生成文件式产物。它把“上次聊到哪里”改为“当前进度”，并按真人输出“参与者进度”：最近完成、当前推进、待确认或阻塞。动态来源的优先级是最新 accepted Personal Card、本人负责的 Task/Task Card、Topic、Human Event；人物画像只用于角色和任务边界，不能被用来推测一个人的当前进度或意图。Briefing 根据当前最大未对齐点和项目进度提出最多 1-2 个“建议主题”，每个建议都必须有原因、期望结果和来源。

标准评审模式的流程是：企业微信群中明确请求 Briefing 后，Hermes 创建一个暂不绑定 Human Event 的 Briefing Topic，先把初版 MD/JSON 持久化到 `05-agent-outputs/project-hermes/meeting-briefings/`，再创建一张 `author: Hermes` 的 Personal Card，并为每位参会人创建评审 Task。初版 Briefing Personal Card 和评审状态立即显示在该 Topic 下。初版 Briefing 的 MD/JSON 必须记录公开 URL、SHA-256、来源截止时间和 Memory 使用证据；评审 Fan-out 的父、拆分和子 Task 都通过 `input_artifacts` 携带同一份完整 Briefing，初始 Relay 消息也必须附带正文，Relay `artifacts` 只保留目标 Agent 的评审产出。

当所有参会人评审 Task 完成，或默认 72 小时到期后，Hermes 根据初版 Briefing 和已收到的反馈生成最终 Briefing。最终 Briefing 不是 Personal Card，而是 Topic 的一句话摘要和“已生成最终会前简报”按钮；按钮打开完整文件，供会议直接使用。评审 Task 的状态必须区分已完成、已到期和未回复，不能把缺失反馈伪装成人类确认。若用户明确要求“直接生成最终 Briefing/会议准备材料/会议简报”，则走直接模式：创建 Briefing Topic、持久化最终 MD/JSON、立即生成最终 Briefing，不创建初版 Personal Card 和参会人评审 Task，页面标记为未经评审的直接生成结果。

当人类在企业微信群中引用另一人的原话并 @Hermes 请求解释时，入口调用 `scripts/explain-quoted-message.mjs`。Hermes 读取请求者与发言者人物画像、项目 Dictionary、已确认 Consensus 和 Project Memory；调用方若能确定上下文，应显式传入 `human_event_id` 或 `topic_id`，解释器再读取对应 Human Event、Topic 和 accepted Personal Card。没有显式 ID 时不得通过相似文本猜历史归属。输出必须保持原话、上下文、术语、歧义和澄清问题分离，不能替发言者下结论，也不自动创建 Card、Topic、Task 或 Memory。

上述读取通过 `scripts/memory-context.mjs` 生成 `usage_id`，由 `scripts/memory-usage.mjs` 追加不含正文的使用审计。`memory-usage-index.json` 只展示聚合使用次数和动作，不暴露聊天原文或模型推理。

Memory 的写入条件是：明确的人类陈述、明确的人类纠正、已收敛 Human Event 共识，或正式权威文件的指针，并且必须有 `source_refs`。`provisional`、`incomplete`、`need_review`、`memory-candidates` 和模型自行推导的内容不能进入 Memory。

最重要的规则是：**Hermes 不得把推测写成事实，禁止将推测写入 Memory。** 找不到定义时必须报告“未定义/待确认”，不能用常识补全。记忆被纠正时保留旧记录，用 `supersedes` 建立新版本和来源链。

`session-notes/` 是历史 Analysis v1 档案。本阶段不迁移、不删除，新材料不再写入；Hermes 默认不把它作为当前事实源。

### 纠错 Topic 与 Correction Task

人类明确指出 Hermes 的错误后，Hermes 在常驻 Topic“Hermes 纠错与持续改进”下创建一个 `task_kind: correction` 的父 Task 和对应 Task Card。父 Task 的 owner 是 Project Hermes；需要人工判断或代码修改时，使用 Manager Review/实施子 Task。

纠错 Task 必须记录原行为、正确行为、纠错类型、适用 Action、目标文件或规则、来源和 Audit Timeline。修复完成并验证后，才创建 active Correction Memory；未完成、冲突或待确认内容不能进入 `10-memory/`。后续 Hermes 只在匹配的 Action 中读取 active Correction Memory，并通过 Memory Usage 审计记录是否读取和采用。

<!-- process:human-event|definition|confirmed -->
## 交流记录

**交流记录是人与人之间的一次交互。** 当前典型来源是 Zac/Vivi 会议和经过明确授权入库的企业微信群聊天记录。内部对象仍称 Human Event，字段仍使用 `human_event_id`。

一个交流记录保存 `human_event_id`、标题、起止时间、`meeting|chat` 类型、人类参与者、Agent 身份、系统机器人、原始 Source、三方 Personal Card、整体总结和关联项目议题。`participants` 只保存人类；ShadowZac 规范为 `agent_participants: Project Hermes`，ToDos 规范为 `system_actors: ToDos`，原始称呼保存在 `source_actor_names`。原始附件在交流记录卡右上角显示为“原始记录”，可直接下载。候选 Topic/Task 在交流记录收敛前不得进入正式任务注册表或 AgentRelay 派发。

推荐状态语义：待收集卡片、待收敛、已完成、不完整、待 Manager Review。候选状态为 `approved`、`rejected`、`need_review` 或 `rejected_l3`。页面状态以实际索引字段为准。

### 项目 Manager

项目 Manager 是独立于普通任务 owner 的项目角色。当前 Manager 为 Zac，配置位于 `03-decisions/project-roles.json`。Hermes 无法判断的 Topic、Task、归属或冲突统一创建 Review Task，派给当前 Manager；不得将 Zac 硬编码为所有普通任务的负责人。

<!-- process:personal-card|definition|confirmed -->
## Personal Card

**Personal Card 是 Hermes、Zac 或 Vivi 针对交流记录或项目议题提交的个人记录。** Zac/Vivi 提交完整 Artifact，Hermes 验收后生成随机 Card ID、对应 Content，并用最好的一句话、最多三条 bullet points 生成摘要。Hermes 针对交流记录生成的 Personal Card 只表达 Hermes 对本次交流的总结，不包含候选 Topic/Task 清单。

卡片必须通过有效 `human_event_id` 或 `topic_id` 确定主归属，并记录 `placement_type` / `placement_id`。Zac 和 Vivi 的入口分别是：

```text
08-cards/inbox/zac-draft/
08-cards/inbox/vivi-draft/
```

作者由 Inbox 目录决定。缺少有效关系、作者冲突或无法判断归属时进入 Review，不强行合并。

<!-- process:convergence|decision|confirmed -->
## 交流记录收敛

Zac/Vivi 两张人类卡收齐后，Hermes 使用 transcript、Hermes Card、Zac Card 和 Vivi Card 立即生成整体总结并确认 Topic/Task。若两张卡未收齐，则等待实际派发时间起 72 小时到期后收敛。

Human Event 总结采用自动发布模式，不要求 Zac/Vivi 二次确认。Zac/Vivi 可以随后提交明确绑定该 Human Event 的修订 Personal Card；Hermes 保留上一版总结，使用每位作者最新一张卡重新收敛并发布修订版。

- Zac/Vivi 双方一致：直接确认。
- 只有一方确认，另一方没有反对：Hermes 直接确认。
- 存在冲突、否决或无法判断：标记为 `need_review`，进入 Manager Review。
- 72 小时到期且只有一张人类卡：只落地该卡明确支持且没有矛盾证据的项目。
- 72 小时到期且没有人类卡：写 `incomplete` 总结，不落地 Topic/Task，候选项标记为 `need_review` 并派给 Manager。

72 小时从实际 AgentRelay 卡片提交任务派发时间开始。派发前已收到有效卡片时，不再重复派发该人的任务；该卡直接进入交流记录并参与收敛。

<!-- process:topic|definition|confirmed -->
## Topic

**Topic 是从 Human Event 中提炼出的、可持续讨论和推进的主题。** Hermes 根据三方卡片判断关联已有 Topic，还是创建新 Topic。

Topic 保存 `topic_id`、标题、摘要、来源 Human Event、明确关联的 Topic Personal Card、Task 和状态。仅有 Human Event 关系的 Personal Card 不复制到 Topic。

标题相似不是自动合并依据。只有同一对象、同一阶段、同一次变化才关联已有对象；同主题的新决定、新阶段或明显变化需要形成新的记录。

<!-- process:task|definition|confirmed -->
## Task 与 Task Card

**Task 是实现 Topic 的具体行动；Task Card 是该 Task 的可视化和审计记录。** 两者一对一，Task Card 不等于 Personal Card。Task 创建、派发、讨论、回执、验收和完成都更新同一张 Task Card；Task 完成不额外生成 Hermes Personal Card。

每个正式 Task 至少保存 Task ID、标题、内容、Topic、负责人、完成标准、风险等级、可选截止时间和状态。任务详情的 audit timeline 记录创建、派发、回执、验收和状态变化。

所有正式任务必须先进入 `09-tasks` 注册表，再由唯一 Dispatcher 创建 AgentRelay Task。Task 完成后，Hermes 对照 `done_criteria` 验收并更新原 Task Card；Review、Card Submission 等没有 Task Card 的工作流 Task 只更新本地状态和审计。Fan-out 收集任务例外：父协调 Task、Hermes 的拆分 Task 和 Zac/Vivi 子 Task 都各有专属 Task Card，但只有子 Task 进入 AgentRelay。

### Task Result v1

普通 Task 的完成回执必须形成独立 Result Envelope，保存于 `09-tasks/tasks/<task-id>/results/<result-id>.json` 及可读 Markdown 镜像。正文必须取自当前 AgentRelay Message 的完整提交内容；Relay Artifacts、Hermes 验收摘要、最多三条摘要要点、验证结果和阻塞项一并保存。`task.json` 保存 Result ID 列表和最新 Result 指针，Task Card 展示完整正文，不再只展示一句 Hermes completion summary。

Result ID 对同一来源 Message 稳定，重放只做幂等更新/读取，不重复生成文件或 Card；不同来源 Message 才形成修订 Result。已完成 Task 可以补写缺失 Result，但保持原有状态、完成时间和 Task/Card ID。Fan-out Card 刷新必须读取最新 Result，不能覆盖子 Task 的真实回执。`card_submission` 仍然不生成 Result，因为它只负责验证 Personal Card 入库。

Worker 先在受控结果目录写入 Result Envelope，再调用 `task-sync`；`task-sync` 先持久化 Result，再更新 Task、审计和 Card。Result 内容经过脱敏，输入路径必须位于 Workspace 或受控结果目录内。历史回填只能使用 Worker Relay 快照中的原始 Message，无法找到原文时不得凭摘要补造。

同一 Task 在多次 Human Event 中被讨论时，显式 `task_id` 优先关联原 Task；没有 ID 时，只在同一 Topic 内对规范化标题完全一致的 Task 自动复用。匹配后追加 Human Event、Source 和 `discussed_in_human_event` 审计，不创建新 Task；无法可靠匹配时进入 Review。

<!-- process:relay|flow|confirmed -->
## Fan-out 协调 Task

当一个任务需要同时收集 Zac 和 Vivi 的反馈时，Hermes 创建一组有明确父子关系的本地 Task：

```text
父 Task：收集 Zac 和 Vivi 对 Workspace 的反馈（coordinator = project-hermes）
├── Task：拆分反馈 Task（decomposer = project-hermes）
├── Task：Zac 对 Workspace 的反馈（assignee = zac-agent）
└── Task：Vivi 对 Workspace 的反馈（assignee = vivi-agent）
```

父 Task 和拆分 Task 不通过 AgentRelay 派给 Hermes 自己；两个 assignee Task 才进入 Relay。父 Task 的完成条件是到达 `due_at`，不是等待两个子 Task 都主动关闭。未显式提供截止时间时，父 Task 默认使用创建时间后的 72 小时。到期时 Hermes 读取两个子 Task 的最新状态，将父 Task 收敛为：

- `full`：Zac 和 Vivi 都完成；
- `partial`：一方完成，另一方到期、失败或未完成；
- `no_response`：两方都没有完成。

父 Task Card 展示收集结果、子 Task 状态和总结；每个子 Task Card 独立展示自己的内容、状态和审计时间线。子 Task 的完成是父任务总结的证据，不改变父任务的到期完成规则。Briefing 等输入材料以 `input_artifacts` 写入每一张相关 Task Card，显示 ID、链接和 SHA-256。重复运行按父 Task 的 `dedupe_key` 幂等，不能重复拆分或重复派发。

Hermes 在 WeCom 中通过 `project_fanout_create` 受控工具创建 Fan-out，不需要 terminal，也不得生成一次性执行脚本。Briefing Action 的唯一模型可见入口是 `project_meeting_briefing_request`；它以当前 WeCom Session Context 为准，确定标准评审或直接生成模式，并调用内部工作流。`project_meeting_briefing_generate`、`project_meeting_briefing_finalize_direct` 和 `project_meeting_briefing_review_create` 只供工作流与测试内部使用，不进入模型工具集，也不能只发送一句“请评审 Briefing”。创建成功后，两个子 Task 立即进入 Dispatcher 队列；工作日 10:00 只发送未完成任务提醒。一次创建返回 4 个 Task ID：父 Task、拆分 Task、Zac 子 Task 和 Vivi 子 Task。

## AgentRelay 协作

```text
本地 Agent 请求治理：人 → Zac/Vivi Agent → AgentRelay → Project Hermes
项目派发执行：Project Hermes → 09-tasks → Dispatcher → AgentRelay → Zac/Vivi Agent
```

Project Hermes 是项目管理 Agent 和事实治理者；`zac-agent`、`vivi-agent` 是人类侧执行伙伴。Hermes 发起的 Task 由 Hermes 验收，目标 Agent 提交 Artifact 后，Hermes 对照完成标准决定完成、继续修改或记录阻塞。

L0-L2 动作允许；L3 高影响动作禁止。Hermes 自己负责的编排工作不得通过普通 AgentRelay 路径派给自己。

<!-- process:automation|timeline|confirmed -->
## 自动化节奏

| 时间/触发 | 当前行为 |
|---|---|
| Chat Inbox 文件变化 | 立即创建 Human Event、Hermes Card 和缺失的卡片提交任务 |
| Zac/Vivi Draft 文件变化 | 立即校验明确绑定的卡片并尝试收敛 Human Event |
| 工作日 09:00 | 完整 ingest/reconcile、处理 Review 和遗漏、读取事实并规划新动作 |
| 工作日 10:00 | 只发送全部 pending Task 状态日报，不在此阶段创建任务 |
| Dispatcher path/retry | 及时派发已进入 `09-tasks` 队列的正式任务 |

09:00 是服务重启、漏事件和即时处理失败的补偿机制。日报必须区分消息 delivery 和 Task lifecycle。

<!-- process:review|exception|confirmed -->
## Review 与异常处理

以下情况进入 Review：无法匹配 Human Event/Topic、缺少关系 ID、作者不一致、候选 Topic/Task 有冲突、材料可能重复但证据不足，或 Hermes 无法安全判断新建/关联。

归属 Review 只接受：`link`、`create`、`ignore`。`link` 必须给有效 ID，`create` 必须给新对象标题；决定写入 `review.json` 后，由下一次 ingest 正式归档。

误派的 AgentRelay Task可以关闭以结束错误请求，但这不代表项目目标完成。Relay 终态保持不可变，本地通过追加审计标记 `cancelled` 或相应终态，不伪造回滚。

人工 Review Task 使用 `timeout_policy: default_no_objection` 时，到期即关闭；未回复表示该审核人没有提出异议，Hermes 按现有候选结论继续处理。超时不会伪造人类 Card 或明确支持证据，L3 也不能因沉默获批。该规则不适用于 `card_submission` 和普通执行 Task。

<!-- process:truth|reference|confirmed -->
## 事实源与文件地图

| 优先级 | 来源 | 作用 |
|---|---|---|
| 1 | `03-decisions/` | 已确认的规则、边界和接口约定 |
| 2 | `07-state/PROJECT_STATE.md` | 当前项目状态压缩版 |
| 3 | `README.md` | 项目入口和目录说明 |
| 4 | `02-notes/` | 可复用整理和分析 |
| 5 | `01-raw/` | 原始材料 |
| 6 | `05-agent-outputs/` | Agent 草稿和产出 |
| 7 | 群聊/个人 thread | 线索，不直接作为长期权威 |

运行索引：`08-cards/card_index.json` 提供 Human Event、Card、Topic、Task 的前端数据；`09-tasks/task_index.json` 是任务注册表；`08-cards/review/` 保存待人工判断项；`workspace.html` 是统一的人类入口。

<!-- process:open-questions|open|pending -->
## 待确认设计

暂无已确认但尚未落地的流程设计项。新的 Memory 类型、写入证据或检索规则，必须先更新 `03-decisions/`，再修改运行代码和本页面。
