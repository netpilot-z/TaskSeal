# 实验 0025：Linear Operation v2 与 project-aware fake transport

## 假设

在不修改任何 Operation v1 持久合同的前提下，可以把 Linear Project、Workflow State、可选 Parent Issue 和仓库 ticket source intent 纳入不可漂移的审批计划，并让一次已提交的 journal version 成为 project-aware transport 的唯一 permit。

## 实现范围

- Operation/Plan v1/v2 union reader；
- 固定 v1 persisted golden vector；
- v2 configured/resolved placement、source intent 与独立摘要；
- journal v1 envelope 中的 v1/v2 独立 history replay；
- v2 observed placement 持久化、单记录语义校验与相邻 pair 校验；
- Control Room `project_state` target 安全投影；
- `prepareV2()`、审批、submit/reconcile 版本分派；
- 独立 `LinearWriteTransportV2Port`；
- 固定 project-aware GraphQL create/query document；
- response-lost、client UUID query、placement mismatch 与并发单 permit。

未实现 CLI、HTTP、浏览器审批、真实 HTTP exchange composition、自动 source preflight 或真实 Linear mutation。

## 只读 Linear schema 证据

使用当前已配置凭证执行一次固定 GraphQL introspection，只读取类型字段，没有 mutation：

- HTTP `200`；
- GraphQL errors `0`；
- `IssueCreateInput` 存在 `id/teamId/projectId/stateId/parentId`；
- `Issue` 存在 `team/project/state/parent`；
- `Team` 存在 `organization`。

该证据只证明 2026-07-28 时字段合同可查询，不证明 mutation 权限、目标关联或生产写入口已通过验收。真实单票 pilot 前必须重新做 freshness 和权限检查。

## 失败关闭结果

- v2 Project、State、Parent、source intent、payload 或摘要任一漂移都会被 parser 拒绝。
- 相同 client UUID 的 v1/v2 operation key 相同，但 plan classification 为 conflict。
- v2 transport 未注入时，submit/reconcile 在 begin append 前返回固定 state error，journal 和 v1 transport 不变化。
- create response 的 identity/placement 漂移进入 `outcome_unknown`。
- query response 的 identity/placement 漂移进入 `ambiguous`。
- source intent、configured refs、resolved UUID、payload、raw response 和凭证不进入 Control Room projection。
- 首条 v2 record 落盘后的回滚下限是具备 union reader 的版本。

## 验证

- Operation/journal/projection/dashboard：61 项定向测试通过；
- v1/v2 Coordinator：39 项组合定向测试通过，新增 v2 场景另以 7 项独立回归通过；
- v1/v2 Linear transport：54 项定向测试通过；
- `npm run typecheck`：通过；
- `npm test`：657/657 通过，0 fail、0 skipped、0 todo；
- `git diff --check`：通过；
- 独立后端与架构复审：在 PR 前执行并记录。

## 结论

假设在 fake transport 边界内成立。`NP-2` 建立了真实写 composition 所需的版本化审批与 placement 观察合同，但没有把当前凭证或 HTTP exchange 自动接入 runtime；下一切片必须继续以显式能力开关和单票 pilot 控制真实写入风险。
