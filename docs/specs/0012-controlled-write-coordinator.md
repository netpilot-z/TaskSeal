# 规格 0012：受控 Linear 写入 Coordinator

## 目标

组合受控写状态模型、Provider Operation Journal 与 fake Linear transport，在完全离线条件下跑通：

```text
prepare → approve/reject → submit → reconcile
```

本规格对应 GitHub Issue `#42`。核心安全目标不是宣称 Provider exactly-once，而是证明：

1. create transport call 必须由本次 committed 的 `submitting` version 授权；
2. 同一 operation 在可信单实例内最多消费一次 create permit；
3. 不确定提交、重启和结果落盘失败均不会盲目重放 create；
4. reconciliation 只按持久 client UUID 查询，absent 不自动重试；
5. 所有审批、提交和对账事实都先后进入独立 Operation Journal。

本切片不开放 CLI/HTTP、浏览器审批、global fetch、真实凭证或真实 Linear mutation。

## 所有权与依赖

```text
ControlledWriteCoordinator
  ├─ controlled-write state machine
  ├─ ProviderOperationJournal command/query ports
  ├─ LinearWriteTransportPort
  └─ injected clock
```

- coordinator 位于 application 层，不导入 connector GraphQL exchange、file storage 或外部 endpoint。
- expected version 不由调用者提供；coordinator fresh query latest 后自行生成。
- journal 仍是唯一持久审计；coordinator 不维护第二份 operation 状态。
- fake 只在 composition/test 中注入，不进入 coordinator。
- #29 后续仍直接依赖 journal query port，不依赖 coordinator 内部队列。

## API

```text
open({ journal, transport, clock })
prepare({ configuredTarget, resolvedTarget, clientRequestId, payload })
approve({ operationKey, planDigest, actor })
reject({ operationKey, planDigest, actor })
submit({ operationKey, planDigest })
reconcile({ operationKey, planDigest })
get(operationKey)
history(operationKey)
```

每个命令返回当前已持久化的完整 Operation。相同 prepare、相同审批或 terminal submit/reconcile retry 返回已有 latest，不产生新 version 或 transport call；当前原型不额外持久化“API 调用是 committed 还是 idempotent”的第二份 receipt。

所有输入 exact-key。Operation key 与 plan digest 必须是 canonical SHA-256 digest；actor 沿用 #39 的稳定、非敏感 human actor 规则。任意 accessor、symbol、附加字段、malformed plan 或 scope/payload drift 在 journal/transport 前失败关闭。

## Per-operation queue

Operation Journal 的 promise queue 只覆盖单次 compare-and-append，不能保护：

```text
load latest → append submitting → call transport → append result
```

coordinator 因此按 canonical `operationKey` 保存 promise tail，整个命令序列进入同一 critical section：

- 相同 operation 的 prepare/approval/submit/reconcile 串行；
- 前一命令失败后队列仍继续，但命令开始时会再次检查 coordinator fence；
- tail 清理必须比较 promise identity，旧任务不能删除后续任务；
- 不同 operation 可并行执行 transport；底层 journal 继续串行 whole-file CAS。

这只提供可信单 coordinator 实例语义，不替代多进程 CAS。

## Prepare 与审批

### Prepare

1. coordinator 从注入 clock 生成 canonical timestamp；
2. 调用 #39 的 `createControlledWriteOperation` 生成 v1；
3. 进入 operation queue 并 fresh query；
4. 不存在时以 expected version 0 append；
5. 已存在且 plan digest 相同，返回 existing latest，即使 operation 已推进；
6. 相同 operation key 但 payload、configured scope 或 resolved scope 不同，返回 plan conflict。

`preparedAt` 不属于 plan identity。同一 plan 的 retry 不会因为新的 wall-clock timestamp 产生第二条 v1。

### Approve / reject

- 只允许 v1 `approval_required` 首次决策；
- action 精确绑定 operation key、plan digest 和 actor；
- 完全相同的既存决定返回 latest，不改写首次 `decidedAt`；
- decision 或 actor 不同返回 approval conflict；
- rejected terminal 的 submit/reconcile 都失败关闭，transport 保持 0 calls。

## Submit 与唯一 permit

```text
approved v2
  → begin_submission v3 candidate
  → journal.compareAndAppend(expectedVersion=2)
  → committed ? one createIssue call : zero calls
  → project safe transport result
  → append v4
```

硬规则：

1. 只有本次 v3 append 返回 `committed` 才消费 create permit。
2. `idempotent`、version/plan conflict、write failed、commit outcome unknown 或 reopen-required 都是 0 create。
3. approved 之外不能取得新 permit；existing submitting 要求 reopen，unknown/absent/terminal submit 只返回 existing latest 或失败，不能 create。
4. transport throw、非法 result 或 created correlation 不合法都投影为 outcome unknown。
5. result append 失败发生在 permit 已消费之后；coordinator 必须 fence 当前实例。reopen 若看到 v3，先恢复 unknown，再允许 query，绝不 create。

映射：

| Transport result | State action | Persisted status |
| --- | --- | --- |
| `created` 且 ID/Team correlation 合法 | `submission_created` | `created` |
| exact `not_dispatched` | `submission_not_dispatched` | `failed` |
| `outcome_unknown` / throw / malformed / mismatch | `submission_outcome_unknown` | `outcome_unknown` |

`not_dispatched` 代表 transport 已被调用，但 fake 明确证明外部写没有派发；因此 request count 为 1、external write count 为 0。

## Reconciliation

只有 `outcome_unknown` 或 `reconciliation_absent` 能开始新 attempt：

```text
append reconciling
  → committed ? one queryByClientUuid call : zero query
  → append found/absent/failed/ambiguous
```

| Query result | State action | Persisted status |
| --- | --- | --- |
| found 且 ID/Team correlation 合法 | `reconciliation_found` | `reconciled` |
| absent | `reconciliation_absent` | `reconciliation_absent` |
| failed / throw / malformed | `reconciliation_failed` | `outcome_unknown` |
| ambiguous / correlation mismatch | `reconciliation_ambiguous` | `outcome_unknown` |

Issue #42 中“found 收敛 created”表示业务上确认同一个逻辑 Issue；#39 已接受的持久状态名是 `reconciled`，本切片不发明 `reconciled → created` 转换。

Absent 保持未解决：

- 不自动 query loop；
- 不自动 create；
- 只有新的显式 `reconcile` 才生成下一组 v7/v8、v9/v10 等 attempt。

## Open 与重启恢复

`ControlledWriteCoordinator.open()` 在接受命令前 fresh `listLatest()`：

- leftover `submitting`：append `submission_outcome_unknown`，create/query 都是 0；
- leftover `reconciling`：append `reconciliation_failed`，create/query 都是 0；后续由人工显式 reconcile；
- approved、unknown、absent 和 terminal 状态保持不变；
- 多条 interrupted operation 按 journal latest 的稳定顺序逐条恢复；
- recovery append 失败会让 open 失败，不能部分可用。

自动恢复只写本地安全状态，不执行任何 Provider transport，因此不属于无人值守外部重试。

## Journal failure 与 fence

- begin-submission append 的已知 pre-commit failure：零 transport，可在当前健康 journal 上显式重试。
- begin-submission commit unknown：零 transport，journal/coordinator 要求 reopen；reopen 以实际 v2 或 v3 事实收敛。
- transport 后 result append 的任意 failure：permit 可能已消费，coordinator 全实例 fence。
- reconciliation result append failure：query 可能已执行，coordinator fence；reopen 将 leftover reconciling 转 failed，再由人工显式 query。
- journal 自身的固定 `ProviderOperationJournalError` 可原样传播；任意非 journal 底层异常统一变成固定 coordinator journal error，不保留 cause。

Transport outcome unknown 只 fence该 operation 的 create；Journal commit unknown 或 post-transport persistence failure fence整个 coordinator 实例。

## Clock

- prepare 必须获得有效 `Date`，否则零 journal/transport。
- approval、begin submission/reconciliation 与 recovery 使用不早于 current `updatedAt` 的 timestamp；wall clock 向后跳时 clamp 到 current timestamp。
- transport 已返回后若 clock 失效，结果使用 current transition timestamp 作为 fallback，优先持久化安全分类。
- clock 在 permit 前失效时不得调用 transport。

## Public error

- `CONTROLLED_WRITE_COORDINATOR_INVALID_INPUT`
- `CONTROLLED_WRITE_COORDINATOR_NOT_FOUND`
- `CONTROLLED_WRITE_COORDINATOR_PLAN_CONFLICT`
- `CONTROLLED_WRITE_COORDINATOR_APPROVAL_CONFLICT`
- `CONTROLLED_WRITE_COORDINATOR_STATE_INVALID`
- `CONTROLLED_WRITE_COORDINATOR_CLOCK_INVALID`
- `CONTROLLED_WRITE_COORDINATOR_JOURNAL_FAILED`
- `CONTROLLED_WRITE_COORDINATOR_REOPEN_REQUIRED`

错误只有固定 code/message，不保留 raw payload、transport exception、journal path 或 `Error.cause`。

## 验收

1. prepare/approve/success 历史固定为 v1→v2→v3→v4，fake external write count 为 1。
2. reject、未审批、digest/actor/payload/scope conflict 均在 transport 前失败。
3. 同 operation 并发 submit 只取得一个 committed permit；第二个返回 latest，create count 不增加。
4. idempotent/unknown begin append 都产生零 transport。
5. success、not-dispatched、outcome unknown、found、absent、failed 与 ambiguous 都映射到 #39 的唯一合法 transition。
6. response lost 后 create 不重试，同 UUID query 能 found/reconciled。
7. absent 无后台循环，只有显式 reconcile 增加 query attempt。
8. post-transport append failure fence；reopen 把 leftover submitting 变 unknown，再 query 收敛，不产生第二个 create。
9. file-backed reopen 对 leftover submitting/reconciling 零 transport 恢复。
10. transport/journal 任意错误正文不进入 Operation、public error 或 recursive inspect。
11. 没有 connector/global fetch/CLI/HTTP/真实凭证或 mutation wiring；生产依赖保持为 0。
