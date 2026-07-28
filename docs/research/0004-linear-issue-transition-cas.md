# 研究 0004：Linear Issue 状态迁移与并发前置条件

## 决策

TaskSeal 需要在人工验收后把同一个 Linear Issue 从配置的 Ready State 迁移到 Completed State。实现必须确认 Linear 是否提供原子 expected revision / compare-and-set，避免把写前检查误称为远端并发控制。

## 一手证据

核验日期：2026-07-28。

1. Linear 官方 GraphQL 入门文档使用 `issueUpdate(id, input: { stateId })` 更新 Issue 状态：
   <https://linear.app/developers/graphql>
2. 对当前 workspace 的只读 schema introspection 显示，`IssueUpdateInput` 包含 `stateId`，但不包含 `updatedAt`、`expectedRevision`、`version` 或其他条件更新字段。
3. 当前 schema 的 `IssuePayload` 返回 `success`、`issue` 和 `lastSyncId`；这些返回字段不构成 mutation 的前置条件。

## 结论

- 事实：当前 Linear GraphQL schema 支持按稳定 Issue UUID 调用 `issueUpdate` 并设置 `stateId`。
- 事实：当前 `IssueUpdateInput` 没有可表达 expected revision 的字段。
- 推断：TaskSeal 无法仅通过公开的 `issueUpdate` 合同实现远端线性化 compare-and-set。
- 实施边界：首版使用 exact UUID 的写前读取，绑定 Organization、Team、Project、expected State 和 `updatedAt`；只有本地 `submitting` journal version 已提交后才发送仅含 `stateId` 的 mutation；mutation 后必须再次读取同一 UUID。
- 剩余竞态：写前读取与 mutation 之间仍有 Linear 侧 TOCTOU 窗口。TaskSeal 会缩小写集、检测已观察到的漂移并失败关闭，但不会宣称消除了该窗口。

## 对结果分类的影响

- 写前 scope/state/revision 不一致：`stale`，零 mutation。
- mutation 明确未派发：`failed`。
- mutation 响应丢失或写后读取不可信：`outcome_unknown`，禁止盲目重发。
- 对账读到 exact UUID + exact scope + Completed State：`reconciled`。
- 对账仍读到已批准的 expected State 与 revision：`reconciliation_absent`，保持人工决策。
- 对账读到其他 State、revision 或 scope：`ambiguous`，保持 unknown fence。
