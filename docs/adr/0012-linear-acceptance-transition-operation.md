# ADR 0012：人工验收使用 Transition Operation v3

- 状态：Accepted
- 日期：2026-07-28

## 背景

受控写 Operation v1/v2 的 action 固定为 `work-item.create`。v2 的 source intent、payload、成功状态和 transport permit 都服务于 Linear Issue Create，并已进入持久 journal。NP-7 需要在本地人工验收后更新既有 Issue 的 State，同时绑定同一个 WorkItem、Linear UUID、验收 basis、expected State 和外部 revision。

## 决策

1. 保持 Create Operation v1/v2 的 parser、摘要、状态转换和持久 bytes 不变。
2. 新增 Transition Operation v3：
   - `capability: acceptance.write`
   - `action: work-item.transition`
   - `configuredTarget.kind: issue_state`
   - plan 绑定 WorkItem、Acceptance decision、唯一 Linear Issue UUID、Organization、Team、Project、expected State/revision 和 target State。
3. Provider Operation Journal envelope 仍为 v1，但 reader 扩为 Create v1/v2 + Transition v3 union；相邻 version 只能由同一 variant 的 pair validator 验证。
4. Transition 使用与 Create 相同的人工审批、journal-before-transport、单 permit、unknown fence、reopen recovery 和 exact-ID reconciliation 模式，但直接成功状态命名为 `transitioned`，不伪装为 `created`。
5. 本地 `acceptance.decided` 必须先提交。Linear 同步失败不会回滚本地验收，也不会把远端状态展示为已同步。
6. Reject 只写本地审计，不创建 Transition Operation，不访问 Linear。
7. Transition feature 默认关闭；关闭、缺少配置或缺少凭证时不得构造真实 transport，也不得发起网络请求。

## 原因

- 扩宽 v2 exact schema 会改变已持久化的语义和 rollback 边界。
- 新建第二套 operation journal 会重复 CAS、原子替换、unknown fence 和恢复机制。
- v3 union reader 能保留旧记录，并为不同 action 提供准确的术语、投影和测试。

## 后果

- 第一条 v3 record 持久化后，只能回滚到认识 v3 union reader 的版本。
- Linear 没有 exposed expected revision mutation 参数；v3 只能提供写前 stale fence 和写后核验，不能承诺远端原子 CAS。
- local-first Control Room 的 actor 由服务端启动配置固定，只代表可信本机边界内的 accountable identity；远程认证与 RBAC 留给后续团队平台规格。
