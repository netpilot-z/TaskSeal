# 规格 0023：可审查的任务分解、DAG 派发与协作可观测性

## 背景

TaskSeal 已经具备稳定 Runner、WorkItem、Attempt、Artifact、Evidence 和人工验收，
但仍只能由操作者逐个派发 WorkItem。NP-9 要验证的核心假设是：一个根 WorkItem
能否被拆成由不同数字员工负责的有向无环图，并在不伪造进度、不绕过证据与人工
验收的前提下形成可审查的协作控制面。

## 目标

- 预览并批准一个绑定既有 WorkItem 的有界 DAG。
- 把节点 owner 绑定到批准时的 Runner profile revision。
- 只派发依赖已 accepted、owner 未漂移且仍有容量的节点。
- 复用 application-owned Attempt coordinator 和稳定 Runner 合同。
- 在 Control Room 展示真实节点状态、阻塞原因、证据、重试和 Attempt trace。
- 允许操作者在静默状态下不可逆地退役计划，释放编排 ownership，同时保留历史。

## 范围外

- 自动生成或写入 Linear/GitHub Issue。
- 持久任务队列、定时调度、分布式锁、多进程 leader election。
- 自动批准分解计划、自动接受交付或自动关闭外部任务。
- 动态执行未经信任的第三方插件代码。
- 估算百分比、工时、剩余时间或 Agent “思考进度”。

## 计划合同

计划是 exact v1 plain object，最多 32 个节点、128 条依赖边和 1 MiB 输入。每个
节点必须：

- 引用已存在且不同于根任务的唯一 WorkItem；
- 给出 bounded instruction、acceptance criteria 和 retry policy；
- 指定 registry 中存在的 `ownerRunnerId`；
- 其 skill、handoff、workspace access 必须同时满足 Runner capability 与 Host
  policy；
- 依赖只能引用同一计划节点，且整个图必须无环。

preview 对列表字段做规范化并生成 canonical digest。approve 必须重新读取实时
WorkItem 与 Runner registry，再以操作者提交的 exact digest 做 CAS；浏览器不能
提交 actor 或时间。`planDigest` 只绑定人类审阅的编排意图，不混入动态 Attempt
历史；approve 在取得 lifecycle claim 后，为 root 和全部 node 捕获 Attempt ID
前缀摘要，并与 approval 原子持久化。

批准前已经 accepted 的 WorkItem 必须先经过独立的显式 reopen 合同；首版不隐式
采用旧 Acceptance。legacy approval 没有 Attempt baseline，只能审计和静默退役，
不能继续 dispatch 或 acceptance。

## 派发语义

- `dispatchOnce` 是显式 tick，只启动当前 ready 且容量允许的一批节点。
- ready queue 是内存投影，`durability: "ephemeral"`；节点 settle 后需要再次
  dispatch，不承诺后台自动继续。
- 拓扑顺序稳定来自已批准的 `topologicalOrder`，不按响应顺序或节点名称重算。
- 节点只有在全部依赖 WorkItem 为 accepted 后才可运行和验收。
- 计划节点不能通过普通 `/run` 绕过 DAG；根任务在全部节点 accepted 前也不能
  普通运行或验收。
- approval、普通 Run、DAG dispatch、acceptance 与 retirement 由同一个进程内
  lifecycle dispatcher 仲裁；approval claim 与共享 Attempt coordinator reservation
  之间没有 await 间隙。
- 节点 phase、retry、owner drift、Evidence 和 Attempt trace 只使用批准 baseline
  之后的 Attempt；旧计划的 interrupted/rejected/failed 事实不消耗 replacement
  plan 的重试预算。
- accepted 必须由当前 plan Attempt、批准 owner/profile 与
  `AcceptanceDecision.basis.attemptId` 共同证明；全局 WorkItem status 不能单独
  解锁依赖。root acceptance 同样要求批准 baseline 之后的 completed Attempt。
- retry 只适用于策略明确允许的 failed Attempt；interrupted、人工 rejected、
  owner/profile drift 必须停下等待人工决定。

## 真实进度与可观测性

唯一进度口径是：

```text
acceptedNodes / totalNodes
```

Control Room 展示节点 phase、依赖、批准 owner、实际 Agent、profile match、
Evidence passed/failed/missing、retry 次数与下一可用时间、Attempt trace、active
节点和 ephemeral ready queue。未知状态保守显示，不推断 ready，也不生成百分比。

## 退役与回退

Retirement 是批准计划的唯一终止决定：

```text
active = approved && !retired
```

- 一个 `planId` 最多一个 retirement，退役后永不复活；重新规划必须使用新 ID。
- retirement 绑定原 digest、server-owned actor/time、结构化 reason code 和有界
  audit note。
- retirement 不删除或改写 WorkItem、Attempt、Artifact、Evidence、Acceptance。
- root 与所有节点必须在 coordinator 和 canonical WorkItem 两个事实面均静默。
- retirement 写入期间禁止同计划 dispatch/run；正在提交的 acceptance 也属于
  active lifecycle claim，必须先 settle。
- 成功后 active ownership 和 DAG 门禁释放，历史审批与退役记录继续可查询。
- 相同命令重试返回 idempotent；不同决定冲突。

legacy approval-only envelope 保持 v1；legacy 首条 retirement 升级为 v2。带
Attempt baseline 的 approval record 使用 v2，并写入 envelope v3 形成明确 reader
fence。reader 同时支持 envelope v1/v2/v3 与 approval record v1/v2；旧 bytes 只读时
不自动改写。commit outcome unknown 时 fence 整个 decomposition journal 并要求
reopen。

## HTTP 边界

- `POST /api/decompositions/preview`
- `POST /api/decompositions/approve`
- `POST /api/decompositions/:planId/dispatch`
- `POST /api/decompositions/:planId/retire`
- `GET /api/dashboard`

所有 mutation 只接受 loopback、same-origin、JSON、session CSRF token 与 exact body。
actor/time 由服务端注入。dashboard 同时返回 active orchestration 与 bounded
retirement audit。

## 验收标准

1. 同一 DAG 的列表排列变化产生相同 digest 和稳定拓扑。
2. cycle、dangling edge、重复 WorkItem、递归 root、owner/permission/evidence
   drift 在写入前失败关闭。
3. 派发严格复用共享容量和批准的 Runner 输入；普通 run/acceptance 无法旁路。
4. dependency 只有 accepted 才解锁；完成 Attempt 或上传 Evidence 均不等价于接受。
5. failed retry 有界；interrupted/rejected/profile drift 零自动执行。
6. Control Room 不显示虚构百分比，并完整展示阻塞、owner、证据、重试和 trace。
7. running/cancelling/terminalizing 或 canonical running 的 root/node 均不能退役。
8. approval/run、acceptance/retirement 与 retirement/dispatch 竞态线性化；退役后
   可安全重试，并由新 baseline generation 接管 WorkItem。
9. envelope v1/v2/v3、approval v1/v2、replacement replay、原子存储、未知结果
   fence 和路径重定向防护通过。
10. TypeScript、全量测试、浏览器桌面/移动端和独立 diff review 均通过。
