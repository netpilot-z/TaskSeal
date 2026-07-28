# 实验 0031：可审查的任务分解、DAG 派发与协作可观测性

## 假设

在不建立第二套 WorkItem、不引入持久任务队列或自动验收的前提下，可以把一个根
WorkItem 组织为人工批准的有界 DAG，并由 TaskSeal 统一控制：

- 节点 owner、Runner profile revision、capability 与 Host permission；
- 基于 canonical WorkItem 的依赖、Attempt、Artifact、Evidence 与 Acceptance；
- 共享容量内的显式派发、失败重试和普通 Run 旁路门禁；
- `accepted nodes / total nodes` 真实进度与完整阻塞事实；
- 不可逆、可审计且不篡改交付历史的计划退役；
- replacement plan 与旧 Attempt 历史之间的执行代际隔离。

## 反证条件

- 全局 WorkItem status 或旧计划的 Acceptance 可以直接解锁新计划节点。
- replacement plan 会继承旧 failed/rejected/interrupted Attempt、Evidence 或重试预算。
- approval、普通 Run、acceptance、dispatch 或 retirement 的竞态可以形成双重所有权。
- 节点可以由非批准 owner/profile 的 Attempt 完成并被接受。
- legacy approval 缺少可信水位时仍能继续派发或验收。
- 计划退役会删除、改写或隐藏 WorkItem 与既有交付证据。
- Control Room 需要用 Agent 自报文本或估算百分比表示进度。
- journal 的旧格式必须原地迁移才能读取。

## TDD 过程

1. 先以 plan decoder/preview 测试锁定 exact plain-object schema、32 节点、
   128 条边、1 MiB、稳定拓扑、cycle/dangling/重复 WorkItem/递归 root 失败关闭。
2. 以 Runner registry 测试锁定 owner profile revision、skill、handoff 和 workspace
   capability/permission 双门禁，并修复空 `handoffKinds` manifest 的真实兼容问题。
3. 以 lifecycle journal 测试建立 approval、retirement、CAS、幂等、原子替换、
   commit outcome unknown fence 与 envelope v1/v2 兼容。
4. 独立审查发现 replacement 会错误继承旧 Attempt generation。新增 approval
   record v2，在批准线性化点为 root/node 捕获 Attempt count 与 ID 前缀摘要；
   writer 使用 envelope v3，reader 明确支持 v1/v2/v3。
5. 以 dispatcher 测试锁定稳定拓扑派发、共享容量、accepted-only dependency、
   failed-only bounded retry、interrupted/rejected/profile drift 人工门禁和 root gate。
6. 以 acceptance 回归证明 baseline 前 Attempt、错误 owner/profile、非 completed
   Attempt 和不匹配的 `AcceptanceDecision.basis.attemptId` 均不能解锁当前计划。
7. 以竞态测试先后复现并修复 retirement/ready-root、approval/manual-run、
   approval/acceptance、acceptance/retirement 双向窗口；所有 lifecycle mutation
   在同一个 dispatcher 内先 claim 或 reservation，再进入异步提交。
8. 以 dashboard state 与浏览器 QA 锁定轮询期间草稿/焦点、空白 audit note、
   真实阻塞投影、桌面和 375 px 响应式布局。

## 已验证行为

- Prepared Plan v1 的 digest 只绑定人工审阅意图；动态 Attempt baseline 与 approval
  原子保存但不改写 plan identity。
- approval record v2 覆盖 root 和全部节点；prefix 漂移、baseline 缺失和 current
  generation 不存在时均失败关闭。
- `dispatchOnce` 只派发当前 generation 中 ready 的节点，并复用 application-owned
  Attempt coordinator 与批准的 Runner 输入。
- 普通 Run、人工 acceptance 与 retirement 都经过同一个 lifecycle admission owner。
- dependency、retry、Evidence、trace、actual owner 和 progress 只读取 baseline
  之后的 Attempt suffix。
- Retirement 只在 coordinator、canonical WorkItem 和 acceptance claim 均静默时
  提交；成功后释放 ownership，保留完整审批、退役和交付历史。
- Control Room 展示 accepted-node 进度、依赖、owner/profile、Evidence、retry、
  Attempt trace、ephemeral queue 与 retirement audit，不生成完成百分比。

## 验证结果

- 主交付门禁：全量测试 `872/872` 通过，0 失败、0 跳过、0 取消。
- TypeScript：`tsc --noEmit` 通过。
- NP-9 独立定向复核：`63/63` 通过；dispatcher 竞态与 generation 测试
  `22/22` 通过。
- 一次与其他验证并发的独立全量运行出现 2 个既有 Codex 子进程 cleanup 超时；
  对应文件隔离重跑 `23/23` 通过，未形成 NP-9 回归证据。
- 浏览器桌面 1280 px 与移动端 375 px 均无横向溢出；编排区域可访问，控制台
  0 warning/error。活动计划退役、焦点恢复与轮询草稿保留已完成交互验证。
- `git diff --check` 通过；仓库内容未发现开发者机器绝对路径或真实凭证模式。
- 三路独立复审覆盖架构、领域/并发和 UI，最终均无剩余 P0/P1/P2。

## 结论

技术假设成立。NP-9 已证明 TaskSeal 可以在现有 WorkItem 与 Runner 合同之上形成
可审查、可派发、可观测、可退役的多 Agent DAG 闭环，同时保持 Evidence 和人工
Acceptance 为唯一交付真相。

## 已知边界

- ready queue 与 lifecycle claim 都是单进程内状态；节点 settle 后仍需显式
  dispatch tick。
- 计划只引用既有 WorkItem；自动把 Linear 工作拆成子 Issue 属于后续能力。
- 当前 root 没有独立 owner/instruction 合同；root baseline 只证明 Attempt 发生在
  approval 之后。
- legacy active approval 没有 Attempt baseline，只能审计并退役后以新 plan ID
  重新批准。
- 远程团队使用仍需要认证、TLS、租户/RBAC、分布式调度和审计策略。
