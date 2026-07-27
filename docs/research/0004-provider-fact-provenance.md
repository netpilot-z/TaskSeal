# 研究 0004：Provider fact provenance 与 locator 绑定

- 日期：2026-07-28
- 关联：GitHub Issue `#48`

## 研究结论

TaskSeal 当前可以离线证明 Provider、scope、object type、稳定 ID 与 locator URL 的结构合法，但不能证明 GitHub database ID 与 Issue/PR number，或 Linear UUID 与 identifier，来自同一个远端对象。

最快且可信的技术验证是 apply-time read-only re-read：

```text
reviewed ImportPlan
  → current registry / policy / Workflow gates
  → 从本次 plan action 绑定的精确 event 生成 ProviderFactProvenanceClaim v1
  → 显式注入的可信 verifier 重读 Provider
  → 精确对账 scope + stable ID + locator + revision + content
  → atomic journal commit
```

该方案不把调用方可重算的字段当成 attestation，不引入签名密钥或第二个权威 plan store，也不改变 ImportPlan、ImportBatch、receipt 或历史 replay schema。

## 待决策问题

1. 普通 digest 或新增 JSON 字段能否证明 snapshot 来源？
2. signed connector attestation、apply-time re-read 与 persistent trusted plan store 的成本和边界是什么？
3. GitHub 与 Linear 当前 API 是否提供按 locator 或稳定 ID 重读并对账所需的字段？
4. 如何使网络验证只影响新 apply，而不影响 idempotent receipt 与历史 replay？

## 方案比较

| 方案 | 信任根 | 优点 | 主要成本与风险 | 当前结论 |
| --- | --- | --- | --- | --- |
| Versioned connector attestation | signer 私钥与 verifier key registry | 可跨进程携带、可离线 apply | 必须设计签名/MAC、issuer、轮换、撤销和历史 key；普通 digest 无效 | 暂不采用 |
| Apply-time read-only re-read | composition root 注入的只读 Provider verifier | 直接证明读取时刻的远端映射；无新持久化 schema | apply 依赖网络、凭证、限流与 Provider 可用性；存在读取到本地提交之间的 TOCTOU | 采用 |
| Persistent trusted plan store | 可信 inspection/staging coordinator 与不可变 store | 支持断网审批和稍后 apply | 新增第二权威状态、容量、恢复、保留和 commit-unknown 语义；任意 caller 仍不得直接 stage | 暂不采用 |

## 为什么公开 digest 不是来源证明

`snapshotDigest`、`planDigest` 和 `expectedPlanDigest` 能检测内容是否在审查后改变，但生成算法和全部输入都是公开的。能调用 apply 的进程如果自行构造错误的 ID/URL 组合，也能重算所有 digest。增加另一个未签名的 `locatorDigest`、TypeScript brand 或布尔 `verified` 字段不会改变信任边界。

可信材料必须来自普通 apply caller 不能伪造的 authority：

- 受保护 signer；
- apply 时由可信 connector 直接读取 Provider；
- 或只能由可信 inspection coordinator 写入的权威 store。

## GitHub 一手合同

GitHub Issue 与 Pull Request 使用 repository 内 number 定位，响应同时返回 database `id`、number 和 `html_url`：

- Issue：`GET /repos/{owner}/{repo}/issues/{issue_number}`
- Pull Request：`GET /repos/{owner}/{repo}/pulls/{pull_number}`

单个 Check Run 可以在 repository scope 下按 database ID 读取：

- Check Run：`GET /repos/{owner}/{repo}/check-runs/{check_run_id}`

因此 verifier 可以只信任已通过 registry 的 repository scope，从 plan/candidate 提取 locator，再要求远端响应的 ID、URL、revision 和规范化 content 全部匹配。

来源：

- GitHub REST “Get an issue”：<https://docs.github.com/en/rest/issues/issues?apiVersion=2026-03-10#get-an-issue>
- GitHub REST “Get a pull request”：<https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#get-a-pull-request>
- GitHub REST “Get a check run”：<https://docs.github.com/en/rest/checks/runs?apiVersion=2026-03-10#get-a-check-run>

## Linear 一手合同

Linear GraphQL 使用 `https://api.linear.app/graphql`，单个 Issue 可通过 `issue(id: ...)` 查询。TaskSeal 已使用 UUID 作为稳定 external ID；专用 verifier 查询同时读取：

- `organization.id`
- `issue.id`
- `issue.identifier`
- `issue.url`
- `issue.updatedAt`
- `issue.team.id/key`

这允许把 Organization/Team UUID scope、Issue UUID、identifier URL、revision 与 content 绑定为同一个远端响应。

来源：

- Linear GraphQL API：<https://linear.app/developers/graphql>

## 选定边界

### 短生命周期 claim

`ProviderFactProvenanceClaim v1` 是 application-owned、只在 apply 内存中存在的合同。它由已经通过 registry/policy/base 检查并完成 Domain projection 的 ImportPlan 精确事件生成，而不是从 projection 后 Workflow 中选择“最新”记录，包括：

- provider、object type、stable external ID 与 provider object key；
- 精确 scope；
- Provider-specific locator；
- canonical URL；
- action 绑定的 source revision；
- Provider source observation time、实际 plan event type 与 event occurred time；
- action event 中实际会进入 Domain 的最小 content binding（Issue title、PR head，或 Check head/outcome）；
- 按既有 Provider fact 规则计算的 content digest。

Issue create/link/observation 直接使用对应事件携带的 URL、revision、source time、event time 与 content digest；PR/Check 直接使用对应 artifact/evidence 事件。Issue create/link 的唯一 locator 是 rich external link 外层 URL；canonical preview 不生成 `lastObservation.url`，apply provenance gate 必须拒绝调用方后来加入的该嵌套字段，避免把未验真的第二 locator 写入 journal。Issue create 的 event time 对账远端 created time，source observation time 对账 updated time；其他 Issue/PR/Check event time 对账对应远端 revision/completion time。`work_item.updated` 必须能复用同一 plan 中相同 source key、revision、content digest 与 source time 的 Issue claim。这样即使 Workflow 已含更晚的 PR/Check 历史，本次旧事件也不会被错误地用新事实代替验证，调用方也不能把将落盘的 linked/recorded time 改到未来。

Plan v1 的 remote no-event `skip` 只保留 source key 与 revision，没有 incoming URL/content，无法形成完整证明，因此 GitHub/Linear 新 apply 固定返回 unavailable；已提交 receipt retry 会在此门禁前返回，历史 replay 与 Gitee 离线绑定不受影响。若未来需要提交 remote no-event receipt，应升级 Plan 合同或增加可信、snapshot-bound 的短生命周期输入。

Claim 不进入 plan 或 journal。Verifier 返回的每个结果必须携带对应 claim digest；application 要求结果集合与请求集合一一相等，防止只验证部分对象。一次 apply 最多验证 8 个去重 claim；connector 以 4 路并发分批读取，单请求 timeout 不得超过 15 秒，并用独立 verifier-wide 30 秒 deadline 限制整个调用，即使注入的 fetch 忽略 AbortSignal 也会释放写队列。

### 失败语义

- `IMPORT_PROVENANCE_MISMATCH`：远端返回了可读对象，但 ID、locator、scope、revision 或 content 不一致；
- `IMPORT_PROVENANCE_UNAVAILABLE`：未注入 verifier、凭证缺失、断网、timeout、认证、限流、not-found、无效响应或 verifier 返回无效合同。

两类失败均发生在 journal commit 前，不包含 raw response、凭证或底层错误正文。

### 生命周期

- Receipt lookup 位于 verifier 前；已提交计划重试不访问网络。
- Historical batch replay 不生成 claim、不读取 Provider，也不需要凭证。
- Verifier 或凭证撤销只阻止新的 GitHub/Linear apply。
- GitHub Check Run 只接受官方 status/conclusion 枚举和合法的 completed/incomplete 字段组合；未知枚举归为无效 Provider response。
- Gitee external ID 已包含 repository 与 case-sensitive Issue reference，可继续使用离线结构绑定。
- Re-read 证明读取时刻的事实，不提供跨 Provider 与本地 journal 的分布式锁或原子事务。

## 何时重新评估

出现以下任一要求时，重新比较 signed attestation 与 trusted plan store：

- preview 后必须断网审批和 apply；
- plan 需要跨组织或跨进程传递可信来源；
- Provider 读取成本或限流不允许 apply-time re-read；
- 需要长期保存“当时由哪个 connector/key 观察”的可验证证明；
- 需要不可逆的 provenance grant 撤销或独立合规归档。
