# 规格 0015：Provider fact provenance 与对象级 locator 绑定

## 目标

在既有获批 GitHub repository 或 Linear team scope 内，即使调用方替换 stable source ID、locator URL、revision 或 content 并重算全部公开 digest，新 snapshot apply 也不能写入 journal，除非显式注入的可信只读 verifier 能从 Provider 重新读取并证明这些字段属于同一个远端事实。

本规格对应 GitHub Issue `#48`。

## 不包含

- Provider 外部写回；
- 默认启用网络 apply；
- 凭证、Token、raw response 或错误正文落盘；
- 动态第三方代码加载；
- 新增生产依赖；
- 修改 ImportPlan、PolicyBinding、ImportBatch、receipt 或 canonical event schema；
- 让历史 replay 依赖当前网络、registry、policy 或 verifier。

## 所有权

- application 拥有 `ProviderFactProvenanceClaim v1`、claim digest、结果集合校验与固定失败分类。
- `TaskSealService` 决定 apply 时机，只依赖 application port，不依赖 HTTP、GitHub 或 Linear SDK。
- connector verifier 拥有 Provider-specific locator 解析结果的远端读取、响应规范化和精确对账。
- composition root 显式注入 verifier 与运行时凭证；service 不读取环境变量。
- Domain、Workflow、PolicyBinding、registry 与 storage 不拥有网络 provenance。

## ProviderFactProvenanceClaim v1

每个 claim 必须是 canonical、bounded、版本化的 plain data：

```text
schemaVersion = 1
provider       = github | linear
objectType     = issue | pull_request | check
providerObjectKey
externalId
scopeRef
url
sourceRevisionId
sourceOccurredAt
eventType
eventOccurredAt
contentDigest
content         = issue title | PR head | Check head + outcome
locator        = provider-specific tagged locator
```

支持的 locator：

- `github.issue`：repository scope + positive Issue number；
- `github.pull_request`：repository scope + positive PR number；
- `github.check_run`：repository scope + positive decimal Check Run database ID；
- `linear.issue`：Organization/Team UUID scope + Issue UUID + identifier。

Claim 在单次 Domain projection 成功后生成，但事实材料必须来自 action 所绑定的精确 plan event，不能从 projection 后的 Workflow 选择最新历史：

- Issue create/link：从该事件的 rich external link 取得 URL、revision、source observation time、title 与 content digest；create 的 WorkItem title 必须与 observation title 相同；`lastObservation.url` 必须缺失，不能在已验真的外层 URL 之外持久化第二个未验证 locator；
- Issue observation：从该事件的 observation 取得 URL、revision、source observation time、title 与 content digest，并用 apply 前 Workflow 验证 baseline/current link 上下文；
- `work_item.updated`：自身没有 locator，必须复用同一 plan 中 source key、revision、content digest 完全相同的 Issue claim，且 update event time 必须等于 claim source observation time；
- GitHub PR：从该 action 的 `artifact.linked` 事件取得 URL、event time 与 head revision，source revision 固定使用 action binding；
- GitHub Check：从该 action 的 `evidence.recorded` 事件取得 URL、event time、head revision 与 outcome，source revision 固定使用 action binding。

时间绑定规则：

- Issue `work_item.created`：event time 必须等于远端 `created_at/createdAt`，source observation time 与 source revision 必须等于远端 `updated_at/updatedAt`；
- Issue link/observation：event time、source observation time 与 source revision 均必须等于远端 updated time；
- PR：event time、source observation time 与 source revision 均必须等于远端 `updated_at`；
- Check：event time、source observation time 与 source revision 均必须等于远端 `completed_at`。

同一个 canonical claim 只验证一次，不同 revision/URL 的 claim 即使 source key 相同也不能相互覆盖。任何目标 action 找不到精确事件、locator 不能规范解析或 update 找不到同版本 Issue claim，均失败关闭。

Plan v1 的 GitHub/Linear no-event `skip` 不携带 incoming URL/content，不能建立完整 claim，因此未提交的新 apply 固定 unavailable。已提交 plan 的 receipt retry 仍在 provenance 前短路；历史 replay 与 Gitee 不受影响。

## Verifier port

可信 port 接收排序、去重的 claim 列表并返回 versioned result 列表。每个 result 包含：

- 对应 `claimDigest`；
- `verified` 或 `mismatch` outcome。

Application 必须验证：

- 返回值 shape、版本和 outcome 合法；
- 没有重复或未知 digest；
- 每个请求 claim 恰好有一个 result；
- 任一 mismatch 都使整个 apply 失败。

Verifier 抛错、缺失结果或合同无效统一视为 unavailable，不能把“未验证”降级为成功。

一次 apply 最多允许 8 个去重 claim。只读 connector 每批最多 4 个并发请求，单请求 timeout 必须是 `1..15000ms`，并由独立的 verifier-wide `1..30000ms` deadline（默认 30 秒）约束整个调用。即使 injected fetch/JSON 忽略 AbortSignal，service 也会在总 deadline 后失败关闭并释放写队列。超过 claim 或 timeout 上限必须在 journal 前 unavailable，不能把最大 256 action 顺序放大为长时间写队列占用。

## Apply 顺序

```text
validate plan / expected digest
→ committed receipt short-circuit
→ current ingress registry + no-Domain preflight
→ current per-scope policy and digest
→ conflicts
→ base Workflow stale
→ one Domain projection
→ derive provenance claims from exact plan events
→ read-only verifier
→ create and atomically commit batch
```

这样保证：

- registry、policy、blocked 或 stale plan 不消耗网络；
- verifier 看到实际准备提交事件所携带的精确 fact，不会被 candidate 中更新的同源历史替换；
- verifier 失败时零 journal 写入；
- verifier 成功后仍只做一次 Domain projection；
- receipt idempotent retry 不访问 verifier；
- replay 不访问 verifier。

## GitHub verifier

Repository 只从已验证 scopeRef 提取，不能从 locator URL 自报。

### Issue

按 URL 中的 Issue number 调用单对象 endpoint，精确比较：

- response database ID ↔ claim external ID/object key；
- response number ↔ locator number；
- response `html_url` ↔ claim URL；
- response `updated_at` ↔ claim source revision；
- response `created_at/updated_at` ↔ claim event/source occurrence times；
- 规范化 source object + title/created time digest ↔ claim content digest；
- response title ↔ claim 的 event title content binding；
- issue-shaped Pull Request 必须拒绝。

### Pull Request

按 URL 中的 PR number 调用单对象 endpoint，精确比较 database ID、number、`html_url`、`updated_at`、event/source occurrence times、head SHA、event head content binding 和 content digest。

### Check Run

按 claim external ID 调用 repository-scoped 单对象 endpoint，精确比较 ID、`details_url`、`completed_at`、event/source occurrence times、head SHA、完成状态、outcome、event head/outcome content binding 与 content digest。响应只接受 GitHub 官方 status/conclusion 枚举；completed 必须同时有合法 conclusion 与 `completed_at`，未完成状态必须同时为 null，未知枚举或非法组合统一视为无效响应。

## Linear verifier

只按 canonical Issue UUID 查询，同时读取 Organization 与 Issue Team，精确比较：

- Organization UUID ↔ scope parent key；
- Team UUID ↔ scope key；
- Issue UUID ↔ claim external ID/object key；
- Issue identifier ↔ locator identifier，并符合返回 Team key；
- Issue URL ↔ claim URL；
- `updatedAt` ↔ claim source revision；
- `createdAt/updatedAt` ↔ claim event/source occurrence times；
- 规范化 source object + title/created time digest ↔ claim content digest。
- response title ↔ claim 的 event title content binding。

## 错误与安全

- `IMPORT_PROVENANCE_MISMATCH`：可信 read 成功但事实不一致；零写入。
- `IMPORT_PROVENANCE_UNAVAILABLE`：缺少显式 verifier、网络/认证/限流/not-found/timeout、无效 Provider response、无效 verifier result；零写入。
- 对外错误消息固定，不包含 provider response body、token、底层 cause message 或 URL query。
- 凭证只存在于 composition/connector closure，不进入 plan、claim digest 持久化、batch、receipt、日志或测试快照。

## 重启、撤销与回滚

- 已提交 GitHub/Linear batch 继续使用原有 v1 reader 离线 replay。
- 已存在 receipt 的 retry 在 provenance 前返回相同 receipt。
- 移除 verifier、撤销凭证或 Provider outage 只阻止未提交的新 apply。
- 本切片没有 persisted schema writer，因此无需 reader migration；旧二进制仍能读取本切片产生的 batch。
- 若未来把 attestation 或 source binding 持久化，必须另行采用 expand-reader-first，并升级相应 Plan/Batch schema。

## 验收标准

- 同 scope 内伪造 GitHub Issue/PR ID↔number/URL、Check ID↔details URL，重算 plan digest 后仍在 commit 前失败。
- 同 scope 内伪造 Linear UUID↔identifier/URL，重算 plan digest 后仍在 commit 前失败。
- revision/content 在 preview 后改变时失败关闭。
- GitHub/Linear 新 apply 未注入 verifier 时失败关闭；Gitee apply 不要求网络 verifier。
- GitHub/Linear no-event plan 与伪造 no-event revision 不产生 receipt；已提交 plan 的 idempotent retry 保持离线。
- PR/Check claim 始终绑定对应 plan event，即使 apply 前 Workflow 已含同 source 的更新历史。
- Issue event title 被重写并重算公开 plan digest 后仍不能提交。
- Issue create/link 的 `lastObservation.url` 被加入并重算公开 plan digest 后仍不能提交。
- Issue create/observation/update、PR artifact 与 Check evidence 的 persisted event/source time 被改写并重算公开 plan digest 后仍不能提交。
- 单次 claim 数、并发数与 timeout 上限均有自动化测试。
- verifier partial/duplicate/unknown/malformed result 不可提交。
- registry、policy、blocked、base stale、receipt idempotent 路径不调用 verifier。
- mismatch/unavailable 均为零 journal write。
- GitHub Issue/PR/Check 与 Linear Issue 使用 mocked-real HTTP/GraphQL contract 验证。
- verifier 被移除、凭证缺失或断网时，历史 batch/receipt 仍可 reopen。
- 完整测试、typecheck、架构与安全审查通过。
