# 研究 0003：Linear 受控写 Correlation 合同

## 研究结论

- 要支持的决策：受控 `issueCreate` 响应丢失后，如何使用持久 client UUID 精确查询同一个 Issue。
- 建议：把 `OperationPlan.clientRequestId` 直接作为 GraphQL `IssueCreateInput.id`；reconciliation 使用单对象 `issue(id: clientRequestId)` 查询，并要求返回 `issue.id` 与 plan 完全一致。
- 置信度与边界：官方 schema 明确允许创建时提供 UUID v4 `id`，官方开发文档明确支持按 Issue UUID 查询。该证据不等于 Linear 承诺重复 create 是幂等；TaskSeal 仍必须依靠 Operation Journal、unknown fence 与查询对账。

## 关键问题

1. `IssueCreateInput` 是否允许调用方提供稳定 UUID？
2. 是否能用同一个 UUID 精确读取 Issue？
3. 这是否足以把重复 create 当作 Provider 原生幂等？

## 关键证据

| 主张 | 类型 | 证据 | 日期/版本 | 限制 |
| --- | --- | --- | --- | --- |
| `IssueCreateInput.id` 可由调用方提供，格式为 UUID v4；未提供时后端生成 | 事实 | Linear 官方仓库 `packages/sdk/src/schema.graphql` 的 `IssueCreateInput.id` 描述 | commit `8335e09`，2026-07-22 | GraphQL schema 持续演进，真实写前需重新核验 |
| 单个 Issue 可通过 `issue(id: ...)` 查询，id 可使用创建返回的 UUID 或 shorthand identifier | 事实 | Linear Developers “Getting started / Queries & Mutations” | 2026-07-27 查阅 | 文档未承诺查询在权限变化或复制延迟下立即可见 |
| 重复 `issueCreate` 使用相同 `id` 具有原生幂等保证 | 未知 | 官方 schema/开发文档未给出此承诺 | 2026-07-27 | 不能据此盲重试 |

## 固定的 fake 合同

```text
create input:
  id          = plan.clientRequestId
  teamId      = plan.resolvedTarget.teamId
  title       = plan.payload.title
  description = plan.payload.description

reconcile query:
  issue(id: plan.clientRequestId)
```

found 结果还必须满足：

- `issue.id === plan.clientRequestId`；
- `issue.team.id === plan.resolvedTarget.teamId`；
- identifier 符合已验证的 Team key/number 格式。

不按 title、description、时间窗口或“第一条搜索结果”建立关联。

## 未知项与停止条件

- 相同 UUID 的重复 create 如何分类、not-found 的可见性延迟和权限错误差异，仍需受控 fake 覆盖，并在任何真实 mutation 前用官方当前 schema 加一个专用 probe。
- 本研究只支持 `#41` 构造 realistic fake，不授权真实 Linear mutation。
- 如果未来 schema 移除 caller-provided `id`，停止真实写路线并重新设计 correlation；不能退化为标题搜索。

## 来源

- Linear 官方 GraphQL 文档：<https://linear.app/developers/graphql>
- Linear 官方 schema（固定 commit）：<https://github.com/linear/linear/blob/8335e09a17dd8aa351dace3d05a94a55e78dad2a/packages/sdk/src/schema.graphql>
- Linear API 演进说明：<https://linear.app/developers/deprecations>
