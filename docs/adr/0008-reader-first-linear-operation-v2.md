# ADR 0008：Linear Operation v2 采用 reader-first 双版本演进

- 状态：Accepted
- 日期：2026-07-28
- 关联：Linear `NP-2`

## 背景

Operation v1 已证明 Team-scoped 审批、journal-before-transport permit、未知结果 fence 与 client UUID reconciliation，但它没有绑定 Linear Project、Workflow State、可选 Parent Issue 或仓库 ticket source intent。把这些字段直接追加到 v1 会改变历史 record、摘要和 exact-key parser，破坏既有 journal replay。

TaskSeal 还必须避免出现一种旁路：审批只看到 Team，而真实 transport 在提交时从当前配置补入 Project/State。该做法会让实际写入 placement 不受 `planDigest` 约束。

## 决策

采用 reader-first 的 v1/v2 union：

1. `createControlledWriteOperation()` 永久保留 v1；新增显式 `createControlledWriteOperationV2()`。
2. Operation Journal envelope 继续使用 schema v1，但 record reader 同时接受 Operation v1/v2。
3. 同一 operation history 不允许跨版本迁移。v1 operation 要采用 v2 合同必须使用新的 client UUID。
4. v2 `operationKey` 继续使用 v1 identity preimage，使同一 client UUID 的跨版本复用表现为 plan conflict，而不是第二个可提交 operation。
5. v2 `planDigest` 绑定 configured workspace/team/project/state、resolved Organization/Team/Project/State/Parent UUID、source intent、payload 和各自摘要。
6. v2 成功 record 保存经过白名单裁剪的 observed placement。单记录 parser 和相邻 pair validator 都必须将它与 plan placement 精确对账。
7. 保留 v1 `LinearWriteTransportPort`，新增独立 `LinearWriteTransportV2Port`；旧 fake、旧 GraphQL document 和旧 response parser 不扩宽。
8. Coordinator 的 v2 transport 是可选能力。缺失时可以 prepare/approve/reject，但 submit/reconcile 必须在 begin transition append 前失败，保持零 permit、零 transport。
9. v2 transport input 只能从已 committed 的 v2 snapshot 显式投影；source intent 不发送给 Linear。
10. v2 create/query 同时观察 Organization、Team、Project、State 和 Parent。create mismatch 进入 `outcome_unknown`，query mismatch 进入 `ambiguous`。

## 发布顺序

1. 先发布 v1/v2 union reader、journal replay 和安全 projection。
2. 再启用 v2 prepare、审批和 project-aware fake transport。
3. 最后才允许显式 composition 连接真实 HTTP exchange，并在单票 pilot 前重新验证 schema、权限、source 与 placement freshness。

首条 v2 record 持久化后，最低可回滚版本是已经具备 union reader 的版本；不得回退到只识别 v1 record 的二进制。

## 被拒绝方案

### 给 v1 增加可选 Project/State 字段

拒绝。它会让 v1 exact schema、digest 与历史 bytes 失去稳定合同，也容易形成“字段存在但未进入审批摘要”的半升级状态。

### 新建第二套 v2 journal

拒绝。现有状态机、CAS、recovery 和 projection 可以安全复用；双 journal 会制造两个外部写审计来源和更复杂的恢复边界。

### 在 transport composition 时补 placement

拒绝。任何未进入 committed plan 的 placement 都没有被人工审批，属于 capability bypass。

## 后果

- v1 历史 bytes、摘要、reader、fake transport 和 GraphQL request 保持兼容。
- Operation 与 transport 都增加显式版本分支和测试成本。
- Control Room 仍只显示 configured target 的 `kind/key`，不会泄露 resolved UUID、source intent、payload 或 Issue identity。
- 当前实现仍没有 CLI、HTTP、浏览器写入口或真实 mutation composition；schema introspection 只证明字段合同存在，不证明生产写入已获准。
- 真实写入口必须继续遵守人工审批、journal-before-transport、client UUID reconciliation 和 unknown fence。
