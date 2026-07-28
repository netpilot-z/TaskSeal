# ADR 0014：独立保存已批准分解计划并显式派发 DAG

## 状态

已接受。

## 背景

WorkItem journal 是交付事实的权威来源，但分解计划包含另一类事实：某个人在某个
时间批准了哪张图、为节点选择了哪个 Runner profile，以及何时终止该编排。若把
计划伪装成 Workflow event，会迫使既有事件 schema 与 digest 一次性迁移；若只保留
在内存中，重启后又无法证明 owner、依赖和人工批准。

## 决策

使用独立的 `.taskseal/decomposition-plans.json` lifecycle journal：

- approval 保存 prepared plan、canonical digest、server-owned actor/time；
- baseline approval record v2 额外保存 root/node 的 Attempt count 与 ID 前缀摘要；
- active 查询只返回未退休计划，供 dispatcher 和所有 bypass gate 使用；
- lifecycle 查询保留 approval 与 retirement，供审计使用；
- legacy approval-only 使用 exact envelope v1，首次 retirement 升级到 v2；
- 新 baseline approval 写 envelope v3；reader 同时读取 envelope v1/v2/v3 与
  approval record v1/v2，writer 采用原子 whole-file replace；
- commit outcome unknown 后实例 fail closed，只有 reopen 能恢复。

DAG 不建立第二套 WorkItem。节点引用 canonical WorkItem；Attempt、Artifact、
Evidence 和 Acceptance 继续只存在于原 Workflow journal。派发采用显式
`dispatchOnce`，ready queue 明确是 ephemeral 投影。

Prepared Plan v1 与 `planDigest` 只表示人类审阅的 DAG 意图。Attempt baseline 是
批准线性化点捕获的执行代际，不放进 plan digest；它与 approval 原子提交。投影、
重试、依赖和验收只读取 baseline 之后的 Attempt suffix，prefix digest 漂移时失败
关闭。批准前已经 accepted 的 WorkItem 要求显式 reopen，不做隐式 adoption。

Retirement 是终态而不是删除或 pause/resume。它必须通过 control-owned 的唯一
lifecycle dispatcher，在 coordinator 与 WorkItem 双重静默检查后写入；直接
retirement mutation 不暴露给 HTTP 或其他 application 调用者。

同一个 dispatcher 还负责 approval claim、普通 Run reservation、acceptance claim
和 retirement fence。run 先发生时 coordinator reservation 使 approval 失败；
approval 先发生时 claim 使 run 失败。两条路径在同一同步调用栈内建立线性化点。

## 选择理由

- 不迁移既有 Workflow event 与历史 digest。
- approval 与 delivery truth 的职责、恢复和失败边界清楚。
- 计划退役不会篡改交付历史，却能释放 ownership 并回退到普通串行运行。
- 每次新 approval 捕获新的 Attempt generation，replacement 不继承旧 retry、
  rejection、owner 或 Evidence 状态。
- 显式 tick 不会伪装成可靠后台队列，符合当前技术验证范围。
- Runner profile revision 和 plan digest 让 owner drift、stale 操作可复核。

## 被拒绝方案

### 把分解计划写成 Workflow event

会扩大领域事件 union、replay 和 digest 迁移范围，而计划本身不应成为 Attempt 或
验收事实。

### 只在内存保存 DAG

重启会丢失人工批准、owner revision 和 ownership gate，无法安全恢复。

### 自动递归派发直到完成

它需要持久队列、恢复调度和重复执行防护。当前只验证协作合同，因此采用显式 tick。

### 删除 approval 作为回退

会丢失审计和 CAS 证据。Retirement 保留全部历史且不可逆。

### pause/resume

可反复状态引入更多竞态和恢复语义；首版只需要人工终止并以新计划重新批准。

### 把 Attempt baseline 放入 Prepared Plan digest

baseline 是批准瞬间的动态交付水位，不是操作者审阅的编排意图。把它纳入 digest
会让 preview 与 approval 之间的普通历史变化改写计划身份，同时仍无法替代批准
期间的 admission fence，因此将它保存在 approval record v2。

## 影响

正面：

- WorkItem 交付模型保持稳定。
- DAG approval、dispatch、retirement 都有清晰的 authority 与审计面。
- 新 Runner 可通过现有 registry/contract 参与节点执行，无需修改 Domain。

限制：

- queue 不持久，节点 settle 后需要新的 dispatch tick。
- 单进程 lifecycle dispatcher 不等于分布式调度器。
- legacy active approval 没有 baseline，只能退役后以新 plan ID 重新批准。
- 当前 plan 没有 root owner/instruction 合同；root baseline 只证明 Attempt 发生在
  approval 之后。若要证明 root exact instruction，需要单独扩展 plan。
- 历史计划有固定数量和文件大小上限；长期归档策略不在本阶段。
- 计划只引用既有 WorkItem；自动从 Linear 创建/拆分任务留给后续里程碑。

## 回退

未产生 baseline approval 的 legacy 文件仍保持原 v1/v2 bytes。首条 v2 approval
record 会升级为 envelope v3，只能回退到具备 v3 reader 的版本。出现问题时停止
批准新计划并移除 decomposition composition；Workflow journal、WorkItem、Attempt
和交付历史无需迁移或回滚。
