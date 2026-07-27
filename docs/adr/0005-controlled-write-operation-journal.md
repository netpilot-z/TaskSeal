# ADR 0005：受控外部写使用独立 Operation Journal

- 状态：Accepted
- 日期：2026-07-27
- 关联：GitHub Issue `#6`、`#39`、`#40`、`#41`、`#42`、`#29`

## 背景

TaskSeal 已有三类状态：

1. canonical workflow journal：交付领域事实与验收不变量；
2. Provider Observation：每个配置目标的最新只读运行摘要；
3. Linear ticket dry-run：完全离线、`mutationReady: false` 的草案。

Linear Issue 创建横跨本地持久化与外部 Provider，无法与本地文件形成原子事务。尤其在请求已发送但响应丢失时，盲重试可能创建重复 Issue。现有 dry-run idempotency key 只绑定名称型 scope，不能充当真实写入幂等保证。

## 决策

采用独立、versioned Operation Journal 和 Saga：

```text
prepare → approval → submit → created
                          └→ outcome unknown → reconcile
```

- Operation key 只绑定固定 provider/capability/action 与持久 client UUID；resolved Organization/Team UUID、configured target 和 payload 由 plan digest 绑定，因此同一 client UUID 的 scope/payload 漂移失败关闭。
- client UUID 直接作为 Linear `IssueCreateInput.id`，reconciliation 通过 `issue(id: client UUID)` 精确查询；官方合同未承诺重复 create 幂等，因此不能替代 journal/fence。
- approval 绑定 operation key 与 plan digest。
- journal 保存每个不可变 version；单条 record 由 runtime parser 校验，相邻 version 必须调用状态模型唯一的 pair validator 重建合法 action 并做 canonical exact equality，不能只检查 version 连续或在 storage 重写状态规则。
- response 丢失进入 outcome unknown，在按 client UUID 查询对账前禁止再次提交。
- submitting 必须先以 expected version 原子持久化，再消费一次 transport call permit；重启发现遗留 submitting 时只能进入 outcome unknown/reconciliation，不能重放 create。
- transport 必须以可判别结果区分 `not_dispatched` 与 `outcome_unknown`；任何派发后不确定性都不能归为 terminal failed。
- transport port 由 application 层拥有；首个 Linear adapter 只接受显式注入的 fake GraphQL exchange，没有 global fetch、凭证或真实 endpoint fallback。create 侧只有 exchange 明确返回未派发才能终止为 failed，其他请求/响应不确定性一律进入 unknown；query 侧只有合法 null 才是 absent。
- Operation Journal 不复用 canonical workflow journal，也不写入 Provider Observation。
- `#29` 只依赖窄 query port，组合安全 latest projection；不解析 operation 文件，不依赖 coordinator 或 transport。
- `GET /api/providers` v2 同时返回 Observation 与 Operation 两个 component revision，以及只绑定这两个内容指纹的 combined revision；它不是跨文件原子快照，也不是可排序的全局版本。
- 浏览器分别以 Observation 的 `provider + configuredTarget.key / startedAt` 和 Operation 的 `operationKey / version` 防回退；不得跨来源比较时间戳或让写状态覆盖 Observation 五态。
- 首个 file adapter 固定使用 `.taskseal/provider-operations.json`、16 MiB / 512 records 硬边界和 whole-file atomic replace；达到上限时失败关闭，不淘汰历史。

## 选择理由

- 保持交付领域、运行摘要和外部写审计的所有权分离。
- 可明确表达本地/外部非原子边界，而不是伪造 exactly-once。
- 支持重启恢复、人工审查、未知结果查询和后续 Control Room 投影。
- 删除组合层即可回退；canonical journal 与 Provider Observation 不需要迁移。

## 被拒绝方案

### 把写状态加入 Provider Observation

拒绝。Observation 只保留每个目标最新摘要，会覆盖逐 operation 审计；snapshot ready 与 approval/submission 是正交维度。

### 把 Operation 作为 canonical DomainEvent

拒绝。Workflow replay 当前只负责工作项交付与验收；外部写 Saga 会把 Provider 事务故障传播到核心领域并扩大兼容面。

### 依赖 Linear 原生幂等或失败后直接重试

拒绝。当前没有可依赖的 createIssue 原生 idempotency contract；响应丢失后直接重试会产生重复对象。

### 先开放真实 CLI/HTTP mutation

拒绝。必须先用 pure model、bounded journal 和 fake transport 证明审批、幂等和对账边界；真实写入仍需新的明确授权。

## 后果

- 新增一套独立状态模型与持久化文件，增加实现和审查成本。
- 两个本地 store 的组合查询不是跨文件 point-in-time snapshot，只保证下次轮询收敛。
- operation journal 损坏时 Provider v2 组合 API 应失败关闭并让前端保留 last-known projection。
- v2 对 payload、client UUID、resolved UUID、plan digest、actor、Issue identity、原始响应、异常正文和本地路径做字段白名单裁剪；任一 source 失败时返回固定 503，不提供 partial 200。
- 首版只保证单 Control Room 实例写入；多进程 writer 仍需后续锁或单写服务。
- reconciliation absent 保持未解决且禁止 create；允许显式再次 query，但不自动提交或重试，避免在尚未验证 Provider 查询一致性时扩大重复写风险。
- 固定 `wx` temporary slot 把 rename 前残留限制为一个且不做路径清理；合法 orphan 只有在目录、lstat/open、single-link 与权限复核后才能原位复用，异常 temp 需要人工处理。首版也不提供 hash chain，拥有本地写权限的操作者删除完整合法 suffix 无法仅靠 replay 检出。
- storage 处于可信本地单 writer 边界。Node 的 pathname-based rename 无法把目录 identity 与 rename syscall 原子绑定；rename 后复核能把替换识别为 unknown/fence，避免误报 committed 和后续 transport permit，但不能承诺对同权限恶意跨进程目录替换零越界文件系统副作用。需要该强保证时迁移到 owner-only ACL 加 native `openat/renameat`、SQLite 或独立单写服务。
- fake Linear transport 会保存测试用 request/external-write counters 和内存 Issue，但这些不是生产审计；生产审计仍只由 Operation Journal 拥有。真实网络 adapter、凭证、schema probe 与权限边界需要新的规格和明确授权。
- coordinator 使用 per-operation promise tail 覆盖 fresh load、begin append、transport 与 result append。只有本次 begin-submission append 返回 committed 才获得 create permit；idempotent、conflict、write failure、commit unknown 和 reopen-required 都是零 create。
- coordinator open 会把遗留 submitting 转 outcome unknown、把遗留 reconciling 转 failed，但 recovery 不调用任何 transport。transport 后结果落盘失败会 fence 整个 coordinator，必须 reopen 并以 journal 事实对账。
