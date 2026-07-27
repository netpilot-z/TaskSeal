# ADR 0007：Provider fact provenance 使用 apply-time 只读重查

- 状态：Accepted
- 日期：2026-07-28
- 关联：GitHub Issue `#48`

## 背景

TaskSeal 的离线 ingress gate 能确认 provider、精确 scope 与 URL 结构，但 GitHub database ID 和 Issue/PR number、Linear UUID 和 identifier 是不同的远端字段。能构造 plan 的调用方可以伪造同 scope ID/URL 组合并重算所有公开 digest。

需要一个普通 apply caller 不能自行伪造的信任根，同时保持：

- 历史 batch/receipt 离线 replay；
- 不保存 Provider 凭证或 raw response；
- 不把网络与 Provider-specific 规则引入 Domain/storage；
- 不提前引入超过当前技术验证需要的密钥或权威存储。

## 决策

采用显式注入的 apply-time read-only re-read：

- application 定义短生命周期 `ProviderFactProvenanceClaim v1` 与 verifier port；
- TaskSealService 在 current registry、policy、conflict、base stale 和 Domain projection 均通过后，从本次 action 绑定的精确 plan event 生成 claim，不从 candidate Workflow 选择最新历史；
- GitHub/Linear connector verifier 使用只读单对象 API 重读并精确对账；
- 每个 verifier result 必须绑定 claim digest，application 要求请求与结果全集一致；
- GitHub/Linear Plan v1 no-event `skip` 因缺少 incoming locator/content 而失败关闭；receipt retry、历史 replay 与 Gitee 离线绑定不受影响；
- claim 同时携带精确 event 的 source/event occurrence time 与最小 content binding，避免只验证 opaque digest 却提交被改写的时间、Issue title、PR head 或 Check outcome；
- Issue create/link 只允许已进入 claim 的 rich link 外层 URL，拒绝 canonical preview 不会生成的 `lastObservation.url`，避免持久化第二个未经远端对账的 locator；
- 一次 apply 最多 8 个 claim，connector 使用 4 路并发、单请求最多 15 秒，并有独立的 30 秒总 deadline；
- 缺少 verifier、远端不可用或任何不一致都在 journal 前失败关闭；
- Gitee 继续使用 external ID 与 locator 的离线精确关系；
- Claim/result 不持久化，因此现有 Plan/Batch/receipt schema 不变，replay 不访问网络。

## 选择理由

- 它直接把远端 Provider read 作为信任根，而不是把可重算字段误称为证明。
- 不需要 signer、key registry、key rotation、历史 key 或撤销协议。
- 不需要第二个权威 plan store 及其容量、恢复、保留和 commit-unknown 语义。
- 对现有持久化 reader 零迁移，出现问题时可通过停止注入 verifier 立即关闭新 apply。
- 当前没有公开 CLI/HTTP apply route，显式注入不会意外开启默认网络行为。

## 被拒绝方案

### 普通 digest、brand 或 `verified: true`

拒绝。调用方知道算法和全部输入，可以一同重算或伪造，不增加信任根。

### Signed connector attestation

暂不采用。真正可信的方案必须设计 signer 私钥、issuer、keyId、轮换、撤销与历史验证；当前仓库没有这些基础设施。若未来需要跨进程或离线携带来源证明，再单独升级 Snapshot/Plan/Batch schema。

### Persistent trusted plan store

暂不采用。它适合 preview 后断网审批，但新增第二权威状态和恢复协议；而且只有可信 inspection coordinator 才能 stage，否则仍只是保存调用方伪造的数据。

### 把 provenance 放入 PolicyBinding、Domain 或 Observation store

拒绝。PolicyBinding 拥有授权而非来源，Domain 不应依赖网络，Observation 是可失败的非权威读模型。混用会破坏职责和历史 replay。

## 后果

- 未提交的 GitHub/Linear plan 在 apply 时依赖只读凭证、网络与 Provider 可用性。
- 新 apply 未注入 verifier 时返回固定 unavailable 错误；不会静默退回旧的离线弱校验。
- 未提交的 GitHub/Linear no-event plan 也返回 unavailable；若未来需要为 skip 写入 receipt，必须升级 Plan 或引入可信 snapshot-bound 输入。
- 已提交 receipt retry 与历史 journal replay 不依赖 verifier，凭证撤销不破坏启动。
- 远端 revision/content 在 preview 与 apply 之间变化会要求重新 preview。
- 将落盘的 Issue observation、Artifact linked 与 Evidence recorded time 必须与远端 created/updated/completed time 按 event 类型精确匹配，不能通过重算公开 plan digest 写入未来时间。
- 默认验真读取窗口受 8 claim、4 路并发、15 秒单请求上限和独立 30 秒总 deadline 共同约束；仍会在这段时间占用当前 service 的串行写队列。
- Read 与本地 journal commit 之间仍有不可消除的 TOCTOU；该证明是 point-in-time，不是跨系统原子事务。
- Claim v1 不持久化，所以不触发 expand-reader-first。未来任何 persisted provenance v2 writer 必须先发布兼容 reader，再启用写入。
