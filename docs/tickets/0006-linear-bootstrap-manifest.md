# Linear Bootstrap Manifest

本文件只包含尚未完成且尚未建立稳定 Linear UUID/identifier 映射的工作。它是 `sync linear --dry-run` 的默认审查输入；完成映射后必须从本文件移除对应项，详细规格以 `0005-linear-productization-milestone.md` 为准。

## T15.2 — 引入 reader-first 的 Linear Operation v2

- 状态：待执行。
- 目的：把 Project、State 和 source intent 纳入不可漂移的审批合同。
- 范围：v1/v2 union reader、v2 digest、placement、source intent 和 project-aware transport。
- 不包含：真实批量创建或通用多 Provider write abstraction。
- 依赖：T15.1。
- 验收标准：旧 v1 replay 不变，v2 placement/source tamper 失败关闭。
- 验证：golden replay、parser、journal、coordinator 和 transport tests。

## T15.3 — Bootstrap 未完成待办并迁移 GitHub 规划 Issue

- 状态：写权限已验证；等待 T15.2。
- 目的：建立 source ticket 与 Linear UUID/identifier 的稳定映射。
- 范围：manifest digest、prepare-only preview、单票 pilot、逐项审批/提交/对账和开放规划 Issue 迁移。
- 不包含：按标题去重、无人审批或迁移已关闭历史 Issue。
- 依赖：T15.2；Linear Issue 创建/更新/评论权限已验证。
- 验收标准：每个 source 只有一个映射，Team/Project/State/payload 写后重读一致。
- 验证：fake crash/restart、真实单票 smoke、mapping replay 和迁移审计。

## T16 — 从 Linear 领取 ready work

- 状态：待执行。
- 目的：从目标 Project 读取可执行任务并关联本地 WorkItem。
- 范围：Project/Todo scope、分页、stable UUID、依赖信息和显式单票选择。
- 不包含：Linear mutation、模糊标题匹配或无限队列抓取。
- 依赖：T15.1。
- 验收标准：只导入目标 Project/Team 的 ready work，重复读取幂等，阻塞任务不派发。
- 验证：GraphQL contract、scope drift、pagination、依赖门禁和 replay tests。

## T17 — 补齐 Control Room 执行控制

- 状态：待执行。
- 目的：支持任务选择、取消、有界并发和可复核重试。
- 范围：per-task selection、cancel、bounded concurrency、per-run status 和新 Attempt retry。
- 不包含：远程多租户、任意 shell 或无限并发。
- 依赖：T16。
- 验收标准：不固定第一条 WorkItem，不全局锁死无关任务，取消和重试保留历史。
- 验证：application/server concurrency tests 和浏览器检查。

## T18 — 自动收集 GitHub Artifact 与 Evidence

- 状态：待执行。
- 目的：从稳定映射的 PR head 和 Checks 生成可验收证据。
- 范围：WorkItem/branch/PR mapping、revision、required checks、review evidence 和只读 reconcile。
- 不包含：自动 merge、按标题猜 PR 或把 Agent 文本当 Evidence。
- 依赖：T16。
- 验收标准：同 revision 幂等，head 漂移使旧 Evidence 失效，证据缺失不能接受。
- 验证：mocked-real GitHub、revision race、duplicate delivery 和 provenance tests。

## T19 — 人工验收并受控迁移 Linear Done

- 状态：待执行。
- 目的：跑通 Evidence、AcceptanceDecision 和 Linear transition。
- 范围：accept/reject、human actor、expected state/revision、Operation v2 transition 和写后重读。
- 不包含：Agent 自批、自动关闭失败任务或删除 Issue。
- 依赖：T15.2、T18。
- 验收标准：只有当前交付证据完整且人工接受时才能迁移同一 Linear UUID 到 Done。
- 验证：领域不变量、stale transition、response-lost reconcile 和权限边界 tests。

## T20 — 稳定 Runner / 数字员工合同

- 状态：待执行。
- 目的：让 Codex App Server 成为第一个可替换 Runner。
- 范围：capability manifest、I/O envelope、Attempt lifecycle、handoff、timeout/cancel 和 credential isolation。
- 不包含：无沙箱第三方代码、Agent 市场或计费。
- 依赖：T17、T18。
- 验收标准：第二个 fake runner 不修改领域即可接入，runner 不获得控制面凭证。
- 验证：contract、adversarial output、cancel/timeout 和 secret isolation tests。

## T21 — 任务拆解、依赖调度与真实可观测性

- 状态：待执行。
- 目的：让多个数字员工按可审查 DAG 协作并展示真实进度。
- 范围：decomposition plan、DAG、capability matching、queue、retry、attempt trace 和 evidence progress。
- 不包含：无限递归、自主改变目标或硬编码百分比。
- 依赖：T20。
- 验收标准：循环依赖失败，每个节点有 owner/验收/证据，进度可追溯。
- 验证：planner/dispatcher property、failure injection、projection/API/UI tests。

## T22 — 提供可安装 CLI 与插件开发包

- 状态：等待核心闭环。
- 目的：支持其他团队以 CLI-first 方式接入仓库、Provider 和 Runner。
- 范围：编译产物、安装、版本兼容、配置 schema、SDK、示例插件和 contract kit。
- 不包含：无触发条件地迁移 NestJS 或 monorepo。
- 依赖：T19、T20。
- 验收标准：干净环境可安装运行，不兼容插件安全失败，核心不依赖 hosted 服务。
- 验证：pack/install smoke、Node matrix 和示例插件 contract。

## T23 — 用飞书多维表格压力测试 Adapter

- 状态：等待专用只读资源。
- 目的：验证异构 token、动态字段、分页和业务错误合同。
- 范围：只读 health/work-item probe、字段映射和 Adapter 结论。
- 不包含：创建或更新飞书记录。
- 依赖：操作者提供专用只读应用、表格与记录。
- 验收标准：以真实证据实现最小 Adapter 或修订 contract。
- 验证：官方 schema、mocked-real contract、只读 smoke 和 secret redaction。

## T24 — 远程团队与商业化基础

- 状态：等待核心闭环与真实试点。
- 目的：在持续使用证据成立后升级为团队产品。
- 范围：认证、RBAC、租户隔离、数据库/队列、审计、TLS、部署和可靠性。
- 不包含：在没有试点前预先引入重型平台基础设施。
- 依赖：T19、至少一个真实团队试点和新的架构规格。
- 验收标准：由试点 SLO、权限矩阵、威胁模型和迁移/回滚计划定义。
- 验证：安全审查、迁移演练、故障恢复、负载和 canary。
