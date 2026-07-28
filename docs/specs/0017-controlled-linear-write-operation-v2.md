# 规格 0017：受控 Linear 写入 Operation v2

## 目标

在不改写任何 v1 journal record 的前提下，把 Linear Project、Workflow State、可选父 Issue 和仓库 ticket source intent 纳入不可漂移的审批合同，并让 Coordinator 只能从已持久化的 v2 `submitting` snapshot 取得 project-aware fake transport permit。

本规格对应 Linear `NP-2`。它仍不开放 CLI、HTTP、Control Room 或真实 mutation 入口。

## 版本与兼容

- `createControlledWriteOperation()` 保持生成 Operation/Plan v1。
- 新增显式 `createControlledWriteOperationV2()`。
- `parseControlledWriteOperation()` 读取 v1/v2 union；Operation 与 Plan 的 `schemaVersion` 必须相同。
- Provider Operation Journal envelope 继续是 schema v1，但 `records` 可以包含不同 operation 的 v1/v2 record。
- 同一 operation history 不允许跨版本迁移；v1 operation 若要改为 v2，必须使用新的 client UUID。
- v1 operation key、payload digest、plan digest、record bytes、状态机和 replay 行为保持不变。
- 首条 v2 record 持久化后，只能回退到已经具备 union reader 的版本。

## Operation Plan v2

```text
schemaVersion: 2
provider: linear
capability: work-item.write
action: work-item.create
configuredTarget:
  kind: project_state
  key: <由 workspace/team/project/state 确定性生成>
  workspace: <configured ref>
  team: <configured ref>
  project: <configured ref>
  state: <configured ref>
resolvedTarget:
  organizationId: <UUID>
  teamId: <UUID>
  projectId: <UUID>
  stateId: <UUID>
  parentIssueId: <UUID | null>
clientRequestId: <UUID v4>
sourceIntent:
  kind: taskseal.linear-ticket-draft
  source: <repository-relative portable path>
  sourceTicket: <T ticket>
  idempotencyKey: <sha256 digest>
  draftPayloadDigest: <sha256 digest>
sourceIntentDigest: <sha256 digest>
payload:
  title: <string>
  description: <string>
payloadDigest: <sha256 digest>
operationKey: <sha256 digest>
planDigest: <sha256 digest>
```

`configuredTarget.key` 固定为：

```text
linear:project-state-ref:
  <encodeURIComponent(workspace)>/
  <encodeURIComponent(team)>/
  <encodeURIComponent(project)>/
  <encodeURIComponent(state)>
```

实际值是单行字符串；上面的换行只用于说明。Parser 必须从四个 configured ref 重算并精确比较，不能信任自由输入的 key。

`sourceIntent.source` 必须是使用 `/` 的仓库相对路径：不能是绝对路径，不能含反斜杠、盘符、空段、`.` 或 `..` 段。`sourceTicket` 匹配 `^T\d+(?:\.\d+)?$`。`idempotencyKey` 和 `draftPayloadDigest` 对应 dry-run 草案；source intent 不传给 Linear。

`parentIssueId` 必须显式为 canonical UUID 或 `null`。不能在 transport 层额外注入父任务，否则 child placement 会绕过审批。

## 摘要

为了让同一 client UUID 的跨版本复用表现为冲突，v2 `operationKey` 继续使用 v1 完全相同的 preimage：

```text
operationKey = {
  domain: "taskseal.controlled-write.operation-key:v1",
  schemaVersion: 1,
  provider, capability, action, clientRequestId
}
```

Payload 语义未变化，因此 `payloadDigest` 继续使用 `taskseal.controlled-write.payload:v1`。

新增：

```text
sourceIntentDigest = {
  domain: "taskseal.controlled-write.source-intent:v2",
  sourceIntent
}

planDigest = {
  domain: "taskseal.controlled-write.plan:v2",
  plan: <全部 v2 plan 字段，但排除 planDigest>
}
```

现有 Approval 形状不变；`operationKey + planDigest` 已绑定 configured/resolved placement、parent、source intent 和 payload。

## Reader 与状态机

1. v1/v2 分别 exact-key 校验并重算全部摘要。
2. Operation outer schema 与 Plan schema 不一致时失败关闭。
3. Transition 保持现有状态图；v2 的 `submission_created` 与 `reconciliation_found` 额外要求 observed Organization、Team、Project、State、Parent 全部与 plan 一致。
4. v2 create placement mismatch 进入 `outcome_unknown`；v2 query placement mismatch 进入 `ambiguous`。
5. v1 成功 record 仍只保存 Issue `id/identifier`；v2 成功 record 额外保存经过白名单裁剪的 observed Organization、Team、Project、State、Parent UUID。Pair validator 从该持久观察反推 action，再与 plan placement 对账，不能用 plan 值代填观察结果。
6. v2 record 不保存 title、description、URL、raw response、headers 或凭证。
7. 相邻 snapshot 继续由同一个 pair validator 从 next 推导唯一 action并做 canonical equality。

## Coordinator 与 Transport

- 保留 v1 `LinearWriteTransportPort` 和 `prepare()`。
- 新增可选的 `LinearWriteTransportV2Port` 与 `prepareV2()`。
- `prepareV2()` 只从调用输入生成 v2 plan，不读取环境变量、配置或网络。
- v2 submit/reconcile 开始本地状态转换前必须确认 v2 transport 存在；缺失时零 journal append、零 permit、零 transport。
- v2 transport input 的 Organization、Team、Project、State、Parent、client UUID 和 payload 只能从 committed v2 snapshot 投影。
- Connector 的 v2 mutation 显式发送 `projectId/stateId/parentId`；create/query 都观察 Team Organization、Team、Project、State、Parent。
- Project-aware transport 仍只接受注入 exchange，不使用 global fetch 或真实凭证 fallback。

Source preflight、fresh resolver、真实 HTTP exchange composition 和真实 mutation 属于后续显式授权切片；不能塞进纯状态模型或 journal。

## 实施切片

1. v1/v2 类型、creator、parser、digest、transition 与 journal union reader。
2. v2 prepare-only、审批、同 UUID 跨版本冲突和 projection 兼容。
3. v2 transport port、Coordinator permit、project-aware fake GraphQL create/query。
4. 独立审查、全量回归和真实零 mutation 证明。

## 验收标准

1. 固定 v1 golden vector、v1 parser 与 journal replay 完全不变。
2. v2 placement/source/payload 任一字段或摘要被篡改时失败关闭。
3. 相同 client UUID 的 v1/v2 plan operation key 相同，但 plan classification 为 conflict。
4. Journal 可同时重放不同 operation 的 v1/v2 history，并拒绝同 history 混版。
5. Approval 精确绑定 v2 plan；v2 transport 缺失或 begin append 非 committed 时零 transport。
6. v2 create/query request 和 observed placement exact；任何 placement drift 分别收敛为 unknown/ambiguous。
7. response lost、reopen、并发 submit 和 source intent 不泄漏沿用既有安全边界。
8. TypeScript、定向测试、全量测试、diff 检查和独立架构/后端审查通过。
