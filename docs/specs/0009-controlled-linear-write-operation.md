# 规格 0009：受控 Linear 写入 Operation

## 目标

在不访问真实 Linear、不开 CLI/HTTP 写入口的前提下，定义一个可持久化、可审批、可幂等提交和可查询对账的受控写 Operation 合同。

本规格覆盖 GitHub Issue `#6`，并按 `#39 → #40/#41 → #42` 实施。首个切片 `#39` 只实现不可变 plan、状态机与运行时校验。

## 术语

- **Operation Plan**：一次预期 Linear Issue 创建的不可变意图，包含 resolved scope、client request UUID 和 payload。
- **Operation Key**：逻辑操作 identity；相同 client UUID 在固定 provider/capability/action 下只能属于一个 operation，scope 或 payload 漂移表现为冲突。
- **Payload Digest**：规范化 title/description 的内容摘要。
- **Plan Digest**：绑定完整 plan、operation key 与 payload digest 的审批摘要。
- **Approval**：由明确 human actor 对特定 operation key 和 plan digest 作出的 approve/reject 决策。
- **Outcome unknown**：请求可能已到达 Provider，但本地没有可信响应；在查询对账前禁止再次提交。
- **Reconciliation**：按持久 client UUID 查询 Provider，确定 Issue found/absent，不能按标题或时间猜测。

## Operation Plan v1

```text
schemaVersion: 1
provider: linear
capability: work-item.write
action: work-item.create
configuredTarget:
  kind: team
  key: linear:team-ref:<workspace>/<team>
resolvedTarget:
  organizationId: <UUID>
  teamId: <UUID>
clientRequestId: <UUID v4>
payload:
  title: <1..256 Unicode code points>
  description: <0..16,384 Unicode code points>
payloadDigest: sha256:<64 lowercase hex>
operationKey: sha256:<64 lowercase hex>
planDigest: sha256:<64 lowercase hex>
```

规则：

1. Organization/Team 必须是 canonical lowercase RFC 4122 UUID；client request ID 必须是 UUID v4。
2. `operationKey` 不包含 scope 或 payload，确保同一 client UUID 的 scope/payload 漂移表现为同一 operation 的冲突，而不是新 operation。
3. `planDigest` 绑定 configured target、resolved target、client UUID、payload 与所有固定 capability 字段，但明确排除自身。
4. 所有对象 exact-key 校验；字符串必须无首尾空白，title 非空，description 可为空。
5. 不包含凭证、Token、Provider response、外部 URL 或错误正文。

三个摘要统一调用仓库 `digestCanonicalJson`，preimage 分别为：

```text
operationKey = {
  domain: "taskseal.controlled-write.operation-key:v1",
  schemaVersion: 1,
  provider, capability, action, clientRequestId
}

payloadDigest = {
  domain: "taskseal.controlled-write.payload:v1",
  payload
}

planDigest = {
  domain: "taskseal.controlled-write.plan:v1",
  plan: <全部 plan 字段，但排除 planDigest>
}
```

canonical JSON 负责对象 key 排序；domain tag 防止不同摘要用途间发生语义碰撞。

## Operation Record v1

Record 是某个 operation version 的完整不可变状态快照：

```text
schemaVersion: 1
plan: OperationPlan
version: positive integer
status: <state>
approval: null | Approval
submission:
  attempt: 0 | 1
  startedAt: null | RFC3339
  completedAt: null | RFC3339
  issue: null | { id, identifier }
reconciliation: null | {
  attempt: positive integer
  startedAt: RFC3339
  completedAt: null | RFC3339
  result: null | found | absent | failed | ambiguous
  issue: null | IssueIdentity
}
diagnosticCode: null | safe code
createdAt: RFC3339
updatedAt: RFC3339
```

后续 Operation Journal 保存每个 version，以完整 snapshot 形成可重放审计；它不进入 `.taskseal/events.jsonl`。

单个 snapshot 必须通过 `parseControlledWriteOperation`；相邻 snapshot 必须通过 `validateControlledWriteOperationTransition(previous, next)`。后者从 next snapshot 推导唯一合法 action，调用同一状态机重建 expected snapshot，再做 canonical exact equality。Journal 不得只检查两个 snapshot 各自合法或 version 连续，也不得复制一套字段比较规则。

## 状态机

```text
approval_required
  ├─ approve → approved
  └─ reject  → rejected (terminal)

approved
  └─ begin_submission → submitting

submitting
  ├─ submission_created(issue, observedTeamId)
  │                              → created (terminal)
  ├─ submission_not_dispatched  → failed (terminal)
  └─ submission_outcome_unknown → outcome_unknown

outcome_unknown
  └─ begin_reconciliation → reconciling

reconciling
  ├─ reconciliation_found(issue, observedTeamId)
  │                            → reconciled(found, terminal)
  ├─ reconciliation_absent    → reconciliation_absent
  ├─ reconciliation_failed    → outcome_unknown
  └─ reconciliation_ambiguous → outcome_unknown

reconciliation_absent
  └─ begin_reconciliation → reconciling
```

- 每次合法转换 version `+1`，`updatedAt` 不得早于上一 version。
- `approval_required` 之外不能 approve/reject；审批必须绑定当前 `operationKey + planDigest`。
- 只有 approved 可以提交；拒绝和任何非法状态转换必须在 transport 前失败。
- outcome unknown/reconciling 不能再次提交。
- 两条成功 action 必须同时携带 Provider 实际返回的 `observedTeamId`；状态机先验证 `issue.id === plan.clientRequestId` 且 `observedTeamId === plan.resolvedTarget.teamId`，再只保存脱敏 Issue identity。调用方不能先裁掉 Team 后再宣告成功。
- reconciliation absent 仍属于未解决、禁止提交的状态；允许操作者显式再次查询，但不自动重试 create。后续若引入 abandon 或人工 create retry，必须作为新状态转换另行规格化。
- 时间只用于审计和展示；状态新鲜度由 journal version 与合法转换决定。

## 状态不变量

| status | version / approval | submission | reconciliation | diagnostic |
| --- | --- | --- | --- | --- |
| `approval_required` | v1 / null | attempt 0，其余 null | null | null |
| `approved` / `rejected` | v2 / 同名 human decision | attempt 0 | null | null |
| `submitting` | v3 / approved | attempt 1、started、未 completed、无 issue | null | null |
| `created` | v4 / approved | completed、有 issue | null | null |
| `failed` | v4 / approved | completed、无 issue | null | `LINEAR_WRITE_NOT_DISPATCHED` |
| `outcome_unknown` | v4 或 `6 + 2 × (attempt-1)` / approved | completed、无 issue | null 或 `failed/ambiguous` | 对应 unknown/failure/ambiguous safe code |
| `reconciling` | `5 + 2 × (attempt-1)` / approved | completed、无 issue | started、未 completed、result null | 保留上一 version 的 diagnosticCode，可为 null |
| `reconciliation_absent` | `6 + 2 × (attempt-1)` / approved | completed、无 issue | completed、result absent、无 issue | null |
| `reconciled` | `6 + 2 × (attempt-1)` / approved | completed、无 issue | completed、result found、有 issue | null |

所有非空时间满足 `created ≤ approval ≤ submission start ≤ submission complete ≤ reconciliation start ≤ reconciliation complete`；`updatedAt` 必须等于当前 version 的转换时间。除合法转换列出的字段外，plan 和既有审计字段必须与上一 version 完全一致；该相邻版本不变量由状态模型的 pair validator 统一实施。

## Approval v1

```text
decision: approved | rejected
actor:
  type: human
  id: <stable non-secret identifier>
operationKey: <exact current operation key>
planDigest: <exact current plan digest>
decidedAt: canonical RFC3339
```

actor ID 只接受 1–128 个 `[A-Za-z0-9._:-]` 字符且必须以字母或数字开头；不得使用邮箱、display name、Token 或临时 session secret。审批对象任一 digest/scope/payload 漂移均失败关闭。

## Issue identity

成功提交或 found 对账只保存：

```text
id: <canonical lowercase Linear UUID>
identifier: <Team issue identifier, e.g. NP-123>
```

不保存 title、description、URL、raw GraphQL body 或 headers。

Correlation 固定为：

- create 时把 `plan.clientRequestId` 作为 GraphQL `IssueCreateInput.id`；
- reconciliation 使用 `issue(id: plan.clientRequestId)`；
- submission/reconciliation found 的 `IssueIdentity.id` 必须等于 `plan.clientRequestId`，Team 必须等于 resolved Team；
- 不按标题、正文、时间或列表第一项猜测。

Linear 官方 schema 已确认 `IssueCreateInput.id` 接受 UUID v4，官方开发文档已确认单 Issue 可按 UUID 查询；但官方没有承诺重复 create 是原生幂等，因此 unknown fence 与 journal 仍不可省略。证据见 `docs/research/0003-linear-controlled-write-correlation.md`。

## 安全诊断码

Operation Record 只接受：

- `LINEAR_WRITE_NOT_DISPATCHED`
- `LINEAR_WRITE_OUTCOME_UNKNOWN`
- `LINEAR_RECONCILIATION_FAILED`
- `LINEAR_RECONCILIATION_AMBIGUOUS`

错误正文、stack、凭证与 response body 不进入 record。

`failed` 只允许 transport 在调用 Provider 前明确返回 `not_dispatched` 时产生。任何已经派发或无法证明未派发的 timeout、连接中断、HTTP/GraphQL/schema failure 都必须进入 `outcome_unknown`，由 coordinator 使用 transport 的可判别结果决定，不能解析异常正文猜测。

## 字段资源边界

- configured target：最多 512 code points / 2 KiB，匹配 `linear:team-ref:<workspace>/<team>` 且不含空白或控制字符。
- title：1–256 code points / 1 KiB，不含 C0/C1、DEL、LF、Unicode line/paragraph separator。
- description：0–16,384 code points / 64 KiB，只允许 LF/tab 作为控制字符；拒绝 CR、其他 C0/C1、DEL 与 Unicode line/paragraph separator。
- actor ID：1–128 ASCII 字符，最多 512 bytes，使用稳定非敏感伪标识。
- Linear Issue ID：必须等于 plan client UUID；identifier 最多 32 code points / 128 bytes，并匹配 `^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]{0,15}$`。

## 实施切片

1. `#39`：plan/record runtime contract、digest 与纯状态机。
2. `#40`：独立 bounded atomic journal、version replay、重启与故障 fence。
3. `#41`：只可注入 fake 的 Linear create/query transport。
4. `#42`：prepare/approve/submit/reconcile coordinator，并发幂等与重启恢复。`begin_submission` 必须以 `expectedVersion + operationKey + planDigest` 原子 compare-and-append；只有 submitting 已确定持久化后才可调用一次 transport。
5. `#29`：只读安全投影与 Control Room 组合；不得读取 journal 文件内部结构。

## 验收

1. 相同 operation identity 与 payload 可确定性重建；相同 key 不同 payload 被识别为冲突。
2. approval 精确绑定 operation/plan/scope/payload；非法 actor、digest 或时间失败关闭。
3. 所有合法路径按 version 单调推进；非法、回退或终态转换失败关闭。
4. outcome unknown 在 reconciliation 前不能提交；absent 不自动重试。
5. runtime parser 拒绝额外字段、非 canonical UUID/时间、超限内容、unsafe diagnostic 和不一致 record。
6. 领域规则有自动化测试，生产依赖保持为 0。

## 崩溃与恢复规则

1. `approved → submitting` 必须先由 journal 原子提交；提交结果未知时禁止调用 transport，并要求 reopen。
2. 只有已持久化的 submitting version 可消费一次 transport call permit。
3. 重启发现遗留 submitting 时，不重放 create；先追加 outcome unknown，再只允许 reconciliation。
4. transport 返回后，created/not-dispatched/outcome-unknown version 的 journal 提交若结果未知，当前实例 fence；reopen 后按 operation journal 事实与 client UUID 查询收敛，不盲重试。
