# 规格 0011：Fake Linear 写入与对账 Transport

## 目标

在不访问真实 Linear、不给 connector 凭证且不提供 global fetch fallback 的前提下，用一个只能显式注入 GraphQL exchange 的 transport 证明：

1. create 使用持久 client UUID 与 resolved Team UUID 构造固定 mutation；
2. create 响应丢失后能用同一 client UUID 做精确 query；
3. Provider 失败按“明确未派发”和“可能已派发”保守分类；
4. query 能区分 found、absent、failed 与 correlation ambiguous；
5. request/response 有界，结果与错误不保留 raw body、凭证或底层异常正文。

本规格对应 GitHub Issue `#41`。它不接 Operation Journal、coordinator、CLI/HTTP、真实网络或真实 Provider mutation。

## 所有权与依赖

```text
future coordinator (#42)
  → application-owned LinearWriteTransportPort
    ← InjectedLinearWriteTransport adapter
      → explicitly injected fake GraphQL exchange
```

- application 层拥有 `createIssue` / `queryByClientUuid` 输入与可判别结果。
- connector 层拥有 Linear GraphQL document、request envelope、runtime response validation 和错误分类。
- fake exchange 只位于测试支撑层，保存可检查 request history、request count 与 external write count。
- connector 构造器必须显式收到 exchange；没有默认网络实现、endpoint 调用、credential 参数或后台任务。

## Application port

```text
createIssue({
  clientRequestId,
  teamId,
  title,
  description
})
  → created(issue, observedTeamId)
  | not_dispatched(LINEAR_WRITE_NOT_DISPATCHED)
  | outcome_unknown(LINEAR_WRITE_OUTCOME_UNKNOWN)

queryByClientUuid({
  clientRequestId,
  teamId
})
  → found(issue, observedTeamId)
  | absent
  | failed(LINEAR_RECONCILIATION_FAILED)
  | ambiguous(LINEAR_RECONCILIATION_AMBIGUOUS)
```

输入 exact-key 且在 exchange 前校验：

- `clientRequestId` 是 canonical lowercase UUID v4；
- `teamId` 是 canonical lowercase UUID；
- title 最多 256 code points / 1024 bytes，不允许首尾空白、空值、多行或 control；
- description 最多 16,384 code points / 65,536 bytes，可为空和使用 LF/tab，不允许首尾空白或其他 control；
- 非 plain data object、accessor、symbol key、附加字段和 malformed Unicode 均失败关闭；
- 输入错误只返回固定 `LINEAR_WRITE_TRANSPORT_INVALID_INPUT`，且 exchange 调用计数保持 0。

## 固定 GraphQL 合同

create request body：

```text
operationName = TaskSealCreateIssue
variables.input.id          = clientRequestId
variables.input.teamId      = teamId
variables.input.title       = title
variables.input.description = description
```

query request body：

```text
operationName = TaskSealQueryIssue
variables.id  = clientRequestId
```

两个 document 只选择：

```text
issue.id
issue.identifier
issue.team.id
```

request envelope 固定为 `{schemaVersion, operation, body}`，不包含 URL、Authorization、API key、OAuth token 或任意 headers。body 最大 128 KiB。

## Exchange 合同

注入 exchange 只能返回三个 exact-key envelope：

```text
not_dispatched
response_lost
response(status, raw body string)
```

- `not_dispatched` 是唯一能证明 Provider 调用未派发的 create 结果。
- exchange 抛错、`response_lost`、malformed envelope、HTTP 非 2xx、GraphQL errors、invalid JSON/schema、oversized response 或 correlation mismatch，都不能按异常正文猜测是否创建成功。
- response body 最大 64 KiB，超过边界时在 JSON parse 前失败关闭。
- transport 不记录、不回传且不放入 `Error.cause` 的内容包括 raw body、GraphQL error message、底层异常和输入 payload。

## Create 分类

| Exchange / response | Transport 结果 |
| --- | --- |
| exact `not_dispatched` | `not_dispatched` |
| valid success，Issue ID 与 client UUID 一致、Team ID 与 resolved Team 一致 | `created` |
| response lost / timeout / throw | `outcome_unknown` |
| HTTP / GraphQL / JSON / schema failure | `outcome_unknown` |
| success=false、Issue ID/Team/identifier 不可信 | `outcome_unknown` |

transport 不提供 create retry。相同 UUID 是否具备 Provider 原生幂等仍未知；unknown 后只能由 #42 进入 query reconciliation。

## Query 分类

| Query response | Transport 结果 |
| --- | --- |
| `data.issue = null` 且 envelope 合法 | `absent` |
| Issue ID、Team ID 和 identifier 都通过 runtime/correlation 校验 | `found` |
| 返回了对象，但 UUID/Team/identifier 与预期 correlation 不一致 | `ambiguous` |
| response lost / timeout / HTTP / GraphQL / JSON / schema failure | `failed` |

只有合法的 `data.issue = null` 能产生 absent；网络或 schema 故障不得伪装成未找到。

## Fake 证据

fake GraphQL：

- 每次 exchange 增加 request count；
- 只有 create 被明确派发时增加 external write count；
- `not_dispatched` 的 external write count 为 0；
- `response_lost` 先把 Issue 写入 fake store，再丢弃响应，因此随后按 client UUID query 能得到 found；
- 支持 success、not-dispatched、HTTP、GraphQL、timeout、response lost、malformed、oversized 与 correlation mismatch 场景；
- 构造 transport 和持有 rejected Operation 都不会产生后台调用。真正的 submitting permit 与“一次调用”由 #42 的 coordinator/journal 集成测试负责。

## 验收

1. success mutation 变量逐字段绑定 plan 所需 identity/scope/payload，结果只含脱敏 identity。
2. not-dispatched 是唯一 terminal pre-dispatch 分类，且 external write count 为 0。
3. response lost 的 external write count 为 1，随后同 UUID query 返回 found，create 不重试。
4. dispatched/indeterminate create failure 全部 outcome unknown；query failure 全部 failed，不伪造 absent。
5. wrong ID、wrong Team 或 invalid identifier 均不能返回 found。
6. input、request、response、Unicode、byte limit 与 exact-key runtime guard 失败关闭。
7. public result/error 与 recursive inspect 不出现 raw Provider 错误正文或凭证。
8. 没有 global fetch、真实凭证、CLI/HTTP、journal/coordinator wiring 或真实 Linear mutation；生产依赖保持为 0。
