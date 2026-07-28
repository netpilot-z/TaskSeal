# 里程碑 0005：Linear 驱动的产品交付闭环

这些 tickets 是当前产品化路线的仓库内可审查拆分。Linear 是在线执行状态的权威来源；未完成项已同步到 `NP-2`～`NP-12`，稳定映射见 `0007-linear-bootstrap-map.json`，不按标题创建重复 Issue。

## T15.1 — 建立 Linear Tracker Bootstrap 基础

- 状态：已完成；由 Linear `NP-1` 汇总跟踪，代码已合并至 `master`。
- 目的：在不修改 v1 journal 和不执行 mutation 的前提下，精确解析真实 Project/Backlog placement。
- 范围：工作跟踪规范、`linear.project/backlogState` 配置、Project/State resolver、bounded HTTP exchange、dry-run Project 修正、真实只读 smoke。
- 不包含：Operation v2、真实 Issue create、CLI 写命令或状态迁移。
- 依赖：现有 Linear read credential。
- 验收标准：唯一解析 Organization/Team/Project/Backlog State；Project-Team 与 State type 被验证；HTTP uncertainty 安全分类；v1 replay 不变。
- 验证：类型检查、resolver/exchange/配置/dry-run 定向测试、真实只读 smoke、全量回归和独立审查。
- 风险与回退：新模块未接入写链，可直接删除；不产生远端或 persisted schema 变更。

## T15.2 — 引入 reader-first 的 Linear Operation v2

- 状态：已完成；由 Linear `NP-2` 跟踪，代码与证据通过 PR `#53` 合入主线。
- 目的：让真实 placement 和 source intent 成为不可漂移的审批内容。
- 范围：v1/v2 union reader、v2 plan digest、configured/resolved Project/State、source intent、project-aware transport input、placement observation。
- 不包含：通用多 Provider write abstraction、批量自动提交或状态关闭。
- 依赖：T15.1。
- 验收标准：旧 v1 journal byte/digest replay 不变；v2 tamper、placement drift 和 source intent 冲突失败关闭；coordinator 只从 committed v2 submitting 获取 permit。
- 验证：golden v1 fixture、v2 parser/tamper、journal reopen、coordinator concurrency 与 transport contract 测试。
- 风险与回退：expand-reader-first；先发布双读、后启用 v2 writer，关闭 writer 即可回退。

## T15.3 — Bootstrap 未完成待办并迁移 GitHub 规划 Issue

- 状态：已完成；由 Linear `NP-3` 跟踪。11 张子任务、稳定映射、GitHub 规划 Issue 迁移和 Operation v2 均已核验；原生依赖关系作为已记录的权限限制留给后续配置处理。
- 目的：把当前内部产品待办切换到 Linear，并建立稳定 source ticket ↔ Linear UUID/identifier 映射。
- 范围：只含未完成项的 manifest、batch digest、prepare-only preview、单票 pilot、逐项 approve/submit/reconcile；迁移 GitHub `#7`、`#25`、`#32`。
- 不包含：按标题去重、无人审批、遇到 unknown 后继续派发或迁移已关闭历史 Issue。
- 依赖：T15.2；Issue 创建、更新和评论权限可用，原生依赖关系另需通用 `write` scope。
- 验收标准：pilot 创建后 Team/Project/State/payload 读后核验；每个 source 只有一个稳定映射；GitHub 仅在 Linear 对象核验后留链接并关闭。
- 验证：fake crash/restart、真实单票 smoke、read-after-write、mapping replay 和迁移审计。
- 风险与回退：任一 unknown/placement drift 立即停止；已创建 Issue 不删除，由人工决定状态。

## T16 — 从 Linear 领取 ready work

- 状态：已完成；由 Linear `NP-4` 跟踪。
- 目的：让 TaskSeal 从 Linear Project 读取可执行任务，而不是依赖本地第一条 WorkItem。
- 范围：精确 Project + Todo scope、分页、stable UUID mapping、依赖/阻塞信息、选择一张 ready Issue 创建或关联本地 WorkItem。
- 不包含：自动修改 Linear、模糊标题匹配或无限队列抓取。
- 依赖：T15.1；真实远端 bootstrap/迁移启用另受 T15.3 门禁，不阻塞只读实现。
- 验收标准：只导入目标 Project/Team 的 Todo；重复读取幂等；依赖未满足时不派发。
- 验证：GraphQL contract、scope drift、pagination、重复读取、依赖门禁和本地 replay 测试。
- 风险与回退：保持显式 UUID 单票入口；关闭 `linear.readyWork.enabled` 即零网络回退到本地 WorkItem。原生 relation 未建立期间由严格 UUID dependency index 提供拓扑、Linear 实时状态提供完成事实。

## T17 — 补齐 Control Room 执行控制

- 状态：已完成；由 Linear `NP-5` 跟踪。
- 目的：让操作者选择任务、查看 owner 并安全控制运行。
- 范围：任务选择、单任务 cancel、bounded concurrency、per-run status、重试生成新 Attempt。
- 不包含：远程多租户、任意 shell 或无限并发。
- 依赖：T16。
- 验收标准：不再固定选择第一条 WorkItem；一个运行不会全局锁死无关任务；cancel/retry 保留可复核历史。
- 验证：server/application tests、并发/取消状态机、浏览器键盘与移动端检查。
- 风险与回退：application-owned coordinator 只保证单 Control Room 进程；默认并发 1，可通过 `TASKSEAL_MAX_CONCURRENT_RUNS` 显式设置 1～8。terminalization fence 明确区分已接受取消与已锁定终态，持久化失败会留在 runtime error 中。出现调度异常时移除覆盖即可退回串行显式派发。

## T18 — 自动收集 GitHub Artifact 与 Evidence

- 状态：已完成；由 Linear `NP-6` 跟踪。
- 目的：从明确映射的分支/PR/Check 生成可验收交付证据，移除手工编号组合。
- 范围：Linear UUID ↔ WorkItem ↔ branch/PR 映射、PR head revision、required checks、review evidence、read-only reconciliation。
- 不包含：自动 merge、按标题猜 PR 或把 Agent 文本当作 Evidence。
- 依赖：T16、现有 GitHub read/provenance 能力。
- 验收标准：同一 revision 幂等；PR head 漂移使旧 Evidence 失效；缺少 Required Evidence 时不能接受。
- 验证：mocked-real GitHub contract、mapped/fork PR、批量 Check/Review、revision race、duplicate delivery、CLI/runtime atomic apply 和 exact provenance tests。
- 风险与回退：首版只接受 repository-owned 显式 mapping，不实现自动发现；`github.delivery.enabled: false` 时零网络，空 index 是安全 bootstrap。

## T19 — 人工验收并受控迁移 Linear Done

- 状态：待执行。
- 目的：跑通 Artifact/Evidence → AcceptanceDecision → Linear transition 的最后一公里。
- 范围：Control Room accept/reject、accountable human actor、expected state/revision、Operation v2 transition、写后重读。
- 不包含：Agent 自己批准、自动关闭失败任务或直接删除 Issue。
- 依赖：T15.2、T18。
- 验收标准：只有当前成功 Attempt、Artifact 和全部 Evidence 通过时可 accept；只有 accepted 才能把同一 Linear UUID 迁移 Done；拒绝保留原因并生成后续 Attempt。
- 验证：领域不变量、并发/stale transition、response-lost reconcile、浏览器权限边界测试。
- 风险与回退：Linear transition 默认关闭；本地 Acceptance 不因远端失败而伪装已同步。

## T20 — 稳定 Runner / 数字员工合同

- 状态：待执行。
- 目的：把 Codex App Server 从唯一实现提升为第一个可替换 Runner。
- 范围：capability manifest、input/output envelope、Attempt lifecycle、Artifact/Evidence handoff、timeout/cancel、credential isolation 和 contract test kit。
- 不包含：任意第三方代码无沙箱动态执行、Agent 市场或计费。
- 依赖：T17、T18。
- 验收标准：第二个 fake runner 不修改领域即可接入；runner 不能获得 Linear/GitHub 控制面凭证；相同生命周期产生一致 Attempt 事实。
- 验证：contract suite、malformed/adversarial output、cancel/timeout 和 secret isolation。
- 风险与回退：内置 allowlist；第三方 Runner 默认只读和隔离进程。

## T21 — 任务拆解、依赖调度与真实可观测性

- 状态：待执行。
- 目的：支持多个数字员工协作，并让老板视图看到真实工作而非硬编码百分比。
- 范围：人工可审查 decomposition plan、DAG、owner/capability matching、bounded queue、retry policy、attempt trace、evidence progress、blocked reason。
- 不包含：自主修改公司目标、无限递归拆分或基于固定状态映射伪造精确进度。
- 依赖：T20。
- 验收标准：循环依赖失败关闭；每个子任务有 owner/验收/证据；进度由完成的可验收节点计算并保留不确定性。
- 验证：planner/dispatcher property tests、failure injection、投影/API/UI 测试。
- 风险与回退：首版 decomposition 必须人工批准；可回退到单 WorkItem 串行执行。

## T22 — 提供可安装 CLI 与插件开发包

- 状态：等待 T19 核心闭环稳定；对应待迁移的 GitHub `#32`。
- 目的：让其他团队能以 CLI-first 方式接入现有仓库和 Runner，再按需连接 hosted Control Room。
- 范围：编译产物、可安装 CLI、版本兼容、配置 schema、Runner/Provider SDK、示例插件和 contract tests。
- 不包含：立即改成 monorepo/NestJS；只有出现独立部署边界后再触发 ADR 0002 的迁移条件。
- 依赖：T19、T20。
- 验收标准：干净环境安装运行；插件版本不兼容时给出安全诊断；核心包不要求 hosted 服务。
- 验证：pack/install smoke、Node support matrix、example plugin contract 和升级回退测试。
- 风险与回退：保持 private checkout 路径直到发布门禁完整；不发布半成品包。

## T23 — 用飞书多维表格压力测试 Adapter

- 状态：等待专用只读应用/资源；对应待迁移的 GitHub `#25`。
- 目的：验证异构 token、动态字段、分页和业务错误能否适配能力合同。
- 范围：只读 health/work-item probe、字段映射和 Adapter contract 结论。
- 不包含：创建/更新记录、聊天机器人或生产凭证提交。
- 依赖：操作者提供专用只读资源；不阻塞 T15–T22 核心链。
- 验收标准：支持则实现最小 Adapter；不支持则以证据修订 contract。
- 验证：官方 schema、mocked-real contract、真实只读 smoke 和 secret redaction。
- 风险与回退：资源缺失时保持 blocked，不以假数据宣称异构边界已验证。

## T24 — 远程团队与商业化基础

- 状态：等待核心闭环和真实试点。
- 目的：在有人愿意持续使用后，把本地技术验证升级为团队产品。
- 范围：认证、RBAC、租户隔离、数据库/队列、审计、TLS、部署、用量与可靠性目标。
- 不包含：在没有试点证据前提前引入 NestJS、monorepo、Kubernetes 或计费。
- 依赖：T19 核心闭环、至少一个真实团队试点和新的架构规格。
- 验收标准：以试点 SLO、权限矩阵、威胁模型和迁移/回滚计划定义，不在本里程碑预先猜测。
- 验证：安全审查、数据迁移演练、故障恢复、负载与 canary。
- 风险与回退：保持 local-first CLI 可用；远程平台故障不能阻断本地证据读取。
