# TaskSeal 上下文

## 一句话定位

TaskSeal 让人类和 AI Agent 的“已完成”变成有证据、可验收、可追责的交付结果。

## 当前验证范围

当前最快验证路线覆盖两条软件交付链路：

- fixture：`Linear WorkItem → Codex Attempt → GitHub Artifact/Evidence → AcceptanceDecision`
- persistent：`Local WorkItem → Codex App Server Attempt → Control Room`
- provider import：`GitHub/Linear/Gitee read-only fact → trusted ingress registry → per-scope ImportPolicy v2 → deterministic ImportPlan → GitHub/Linear apply-time provenance re-read → atomic local batch → ImportReceipt`
- provider extension：已以 Gitee 提取内置 Adapter Contract v1，并验证 Provider-neutral rich link 与受控本地 import；下一步用飞书多维表格做异构压力测试
- provider observation：`inspection/preview/import → redacted latest-state model → GET /api/providers`，独立于 canonical journal
- controlled external write（fake 验证中）：`OperationPlan → human approval → versioned Operation Journal → fake submit → client UUID reconciliation → safe Control Room projection`

本阶段不构建通用 Agent 市场、多租户权限、计费或生产数据库。Snapshot apply 当前只提供默认关闭的 application API；没有可信 ImportPolicy provider 时不能提交，也尚未开放 CLI/HTTP apply 入口。Registry 证明 Provider/scope 授权和离线可验证的 locator 结构；GitHub/Linear 新 apply 还必须通过显式注入的只读 verifier，以短生命周期 `ProviderFactProvenanceClaim v1` 从精确 plan event 对账远端 stable ID、locator、scope、revision、source/event time、content binding 与 digest。公开 plan digest 不被当作来源证明；未注入 verifier、远端不可用或 Plan v1 remote no-event 时失败关闭。单次最多 8 个 claim、4 路并发、单请求最多 15 秒并受 30 秒总 deadline 约束；已提交 receipt 与历史 batch replay 保持离线。Linear workspace `netpilot-z`、team `netpilot`、project `TaskSeal` 与 backlog state `Backlog` 已通过真实只读 resolver 精确验证。

自 2026-07-28 起，Linear 是内部产品研发任务的权威来源；GitHub Issue 只承载外部 Bug、公开反馈和仓库级问题，GitHub PR/Review/CI 继续承载代码交付。仓库 `docs/tickets/` 是可审查的规格拆分与 bootstrap 输入，不是第二套在线状态；`NP-2`～`NP-12` 已按预存 UUID 创建并回读核验，映射见 `0007-linear-bootstrap-map.json`，默认 `0006` manifest 当前为空。GitHub 规划 Issue `#7`、`#25`、`#32` 已留下 Linear 链接并迁移关闭。Issue 创建、更新和评论权限已验证；`issueRelationCreate` 仍因缺少通用 `write` scope 而失败关闭，因此原生依赖关系尚未建立。TaskSeal 产品内的自动 mutation 仍必须等待 Operation v2 绑定 Project/State/source intent，不能旁路注入 v1。

当前真实环境中，Linear Issue `NP-1` 已完成成功 snapshot；GitHub Issue `#1`、Draft PR `#2` 与 PR head 上的 `tests` Check 已完成完整只读 snapshot 和真实内存重放。Gitee 公共 `oschina/git-osc#I4` 已完成匿名 health/read smoke；自动化测试已证明它只有在 trusted registry 与精确 per-scope policy 同时允许时才能执行本地 preview/apply，direct rich append 仍固定拒绝。该 apply 只写本地 canonical journal，不写回 Gitee。Issue、PR 与 CI 的创建均来自操作者明确授权；TaskSeal 不会从只读检查隐式创建、更新、合并或关闭外部对象。

Provider Observation v1 已使用独立 `.taskseal/provider-observations.json` 保存每个 configured target 的最新脱敏状态。它按 operation start freshness 拒绝晚返回的旧结果，先对账 configured target 与 observed scope，再通过 persistent-only `GET /api/providers` 暴露五态；真实 preview/apply 由持有 verified resolved-scope binding 的 observed application façade 组合，跨 Provider/foreign scope 在业务提交前拒绝，不保存 raw payload、标题、URL、凭证或错误正文，也不会进入 Workflow journal。

Provider Operation Journal v1 已使用固定 `.taskseal/provider-operations.json` 保存受控写的完整 version 历史。它从 v1 开始逐条 parse、逐对验证相邻状态转换，以 `expectedVersion + operationKey + planDigest` 在单实例队列内 compare-and-append；exact latest retry 只返回 idempotent。文件采用 16 MiB / 512 records 硬边界与原子 whole-file replace，rename 后按已 sync temp identity 复核 target，未知结果会 fence 当前实例；合法 orphan temp 可经 identity/single-link 检查复用。当前仅通过 query port 接入只读 Control Room projection，没有 CLI/HTTP command 或真实 Linear mutation；多进程 CAS、密码学防删改和不可信本地并发写者不在首版保证内，pathname rename 也不承诺对同权限恶意跨进程替换零越界副作用。

Fake Linear Write Transport v1 已建立 application-owned `createIssue/queryByClientUuid` port 和只能显式注入 exchange 的 connector。create 使用 client UUID 作为 Issue ID 并绑定 resolved Team；只有明确未派发可返回 not-dispatched，其余派发后不确定性进入 outcome unknown。query 只按 client UUID 精确读取，区分 found、absent、failed 与 correlation ambiguous。现已补充固定 endpoint、单凭证、15 秒 timeout、128 KiB request、64 KiB streaming response 的真实 GraphQL HTTP exchange，以及 Organization/Team/Project/Backlog State 只读 resolver；它们尚未接入 v1 coordinator 或任何 mutation 入口，因为 v1 plan 未绑定 project/state。

Controlled Write Coordinator v1 已组合 prepare/approve/reject/submit/reconcile，并以 per-operation queue 覆盖 journal→transport→journal。只有本次 committed submitting version 能消费一次 fake create permit；idempotent/unknown append、拒绝和非法状态均为零调用。response lost 进入 outcome unknown，再按 client UUID 显式对账；reopen 会把遗留 submitting/reconciling 转为安全本地状态而不调用 transport。当前没有 CLI/HTTP、浏览器审批、global fetch、真实凭证或真实 Linear mutation。

Provider status v2 已由 application façade 并行读取 Provider Observation 与 Operation Journal latest，并通过 persistent-only `GET /api/providers` 返回两个 component revision 和一个 combined content fingerprint。它只白名单投影 target、version、状态、安全 diagnostic 与不含 actor 的 approval 决策；payload、client UUID、resolved UUID、plan digest、Issue identity、错误正文和本地路径不会进入 API。浏览器分别按 Observation startedAt 与 Operation version 防回退，展示 10 种受控写状态和 operation-only target；任一 source 失败整次返回固定 503，last-known 只在浏览器保留。该组合不是跨文件原子快照，也没有任何浏览器写入口。

## 统一语言

| 名称 | 含义 |
| --- | --- |
| `WorkItem` | 需要交付并验收的最小工作单元，可关联外部 Issue。 |
| `Attempt` | 某个 Agent 对一个 WorkItem 的一次执行。失败重试会产生新 Attempt。 |
| `Artifact` | 执行产生的交付物，例如 Pull Request、文档、视频或报告。 |
| `Evidence` | 支持验收判断的可复核事实，例如测试结果、截图、审查结论。 |
| `AcceptanceDecision` | 对 WorkItem 作出的接受或拒绝决定。 |
| `ExternalLink` | WorkItem 与 GitHub、Linear 等外部对象之间的持久关联；同一外部对象全局只能关联一个 WorkItem。 |
| `ProviderObjectKey` | Connector 根据 provider、对象类型与 provider 定义的 scope/object reference 生成稳定对象身份；不使用标题或 URL 作为身份。Gitee 使用 repository-scoped、区分大小写的 Issue reference。 |
| `SourceRevision` | Provider 对象的一次可排序版本，由稳定 revision ID、来源更新时间和规范化内容摘要组成。 |
| `ProviderSnapshot` | 只读 Connector 输出的、经过裁剪且带来源版本的外部事实集合；snapshot 本身不获得写权限。 |
| `ProviderFactProvenanceClaim` | 新 snapshot apply 在内存中从本次 action 绑定的精确 plan event 生成的版本化远端事实主张；由可信只读 verifier 对账 stable ID、locator、scope、revision、source/event time 与 content，结果不进入历史 journal。 |
| `ProviderAdapter` | 仓库内受信任的 Provider 边界，实现 manifest 声明的窄 health/read ports；不直接拥有领域 append、snapshot apply 或未声明的外部写能力。 |
| `AdapterManifest` | 版本化声明 Provider ID、capabilities、配置、credential mode、scope 和 object type 的静态契约；当前不代表可动态安装的第三方代码。 |
| `Capability` | 可独立授权的操作能力，例如 `provider.health`、`work-item.read`；读能力不会隐式获得 transition、apply、comment、close 或 acceptance write。 |
| `ProviderObservation` | application-owned 的 Provider 最新状态摘要，绑定 configured target 与 observed scope；只用于查询和展示，不是 DomainEvent 或外部审计副本。 |
| `OperationPlan` | 一次受控外部写的不可变意图，绑定固定 capability/action、持久 client UUID、resolved scope、payload digest 与 plan digest。 |
| `OperationJournal` | 独立于 Workflow journal 和 Provider Observation 的 versioned 外部写审计；记录审批、提交、未知结果与对账状态。 |
| `OutcomeUnknown` | Provider 请求可能已生效但本地没有可信结果的受控写状态；禁止再次提交，只能按持久 client UUID 对账。 |
| `Reconciliation` | 使用显式 provider identity 查询未知写入结果；found、absent、ambiguous 与失败都必须明确建模，不按标题或时间猜测。 |
| `ImportPlan` | ProviderSnapshot 与当前 Workflow 经纯函数预览后形成的确定性计划，列出追加、更新、跳过和冲突。 |
| `ImportReceipt` | ImportPlan 原子应用后的本地审计回执，绑定 plan digest、操作者和实际提交的 canonical events。 |

## 核心不变量

1. Agent 声称完成不等于 WorkItem 已验收。
2. 接受决定必须建立在交付物和全部必需证据通过的基础上。
3. 同一个外部事件重复投递不得产生重复 Attempt、Artifact 或 Evidence。
4. TaskSeal 保存自身状态，但不冒充 GitHub、Linear 或 Agent Runtime 的事实来源。
5. Codex turn completed 只是 Attempt 终态；没有当前 Artifact、Required Evidence 和 accountable owner 时不得 accepted。
6. 只有成功 completed 的当前 Attempt 才能进入 accepted；失败或中断终态不能被晚到的 Artifact/Evidence 隐式解除。
7. 较旧的外部事实不得清除较新的人类验收决定；失败或中断 Attempt 只有通过新的 Attempt 才能重新开启。
8. Provider payload 与 TaskSeal 关联映射必须分离；WorkItem、Attempt、Artifact 与 criterion 关联不得由标题、时间或第一条结果猜测。
9. 读取与写入是独立能力；只读 Token、snapshot 或 dry-run 不能隐式获得外部创建、更新、关闭或 merge 权限。
10. `ProviderObjectKey` 在全部 WorkItem 中唯一；一个 WorkItem 可以有多个 ExternalLink，但同一个 canonical 字段最多由一个 ExternalLink 管理。
11. snapshot import 只能追加 canonical events，不能直接覆盖 Workflow；preview 永远零写入，apply 必须绑定已审查的 plan digest 和当前 Workflow digest。
12. 一个 ImportPlan 要么连同审计回执完整提交，要么完全不可见；WorkItem/ExternalLink 元数据更新不得绕过专用 canonical events 修改或清空 Attempt、Artifact、Evidence 或 AcceptanceDecision。
13. 新的 rich/provider-managed ExternalLink 只能通过 trusted registry、per-provider/per-scope ImportPolicy v2 与受控 atomic import batch 进入 journal；generic direct append 固定拒绝，replay 不读取当前授权。领域层只校验 Provider-neutral 结构和业务不变量；既有 arbitrary legacy reference 保持非托管，legacy baseline 始终只识别 GitHub/Linear。
14. Provider Observation 的损坏、越界路径、写失败或未知提交结果不得改变 inspection、preview、import 或 Workflow 的业务结果；它只能让 Provider 查询面降级或要求重新打开。
15. 外部写必须先持久化审批与 submitting version，再消费一次 transport call；无法证明未派发的结果一律进入 OutcomeUnknown，重启或重试不得绕过 client UUID 对账。Operation Journal replay 必须同时校验单条 snapshot 和相邻状态转换，不能只凭 version 连续接受审批人、plan 或既有审计字段漂移。
16. Provider status 组合必须保持 Observation 与 Operation 的独立所有权和 source-local freshness；不得跨来源比较时间戳、把写状态覆盖到 Observation 五态、返回 partial success，或把 combined revision 描述成全局可排序版本。
17. GitHub/Linear 新 snapshot apply 必须在 journal commit 前由显式注入的可信只读 verifier 覆盖从精确 plan event 生成的全部 provenance claim；缺失、部分结果、远端不可用、scope/ID/locator/revision/source time/event time/content 漂移、未经验证的嵌套 observation locator 和 remote no-event 均失败关闭。验真最多 8 claim、4 路并发、单请求 15 秒并受 30 秒总 deadline 约束。Committed receipt retry 与历史 batch replay 不得访问 Provider 或要求凭证。
