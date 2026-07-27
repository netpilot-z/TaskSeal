# 审查 0006：Snapshot Import TypeScript 迁移

## 状态

通过。对应 GitHub Issue `#22`；审查对象是 Snapshot Import 的 unknown/runtime guard、规范化阶段、digest 与排序、planner、domain simulation、fixture 和直接测试迁移。

## 独立审查范围

进行了两个互相独立的只读 pass：

1. 架构与代码 pass：类型所有权、scope 授权阶段、tree/schema/URL/candidate guard、digest、排序、冲突、资源限制、测试强度和范围漂移。
2. Verification 与安全 pass：类型检查、直接与间接闭包、全量测试、旧引用、类型逃生口、测试跳过、绝对路径和凭证扫描。

## Finding 与闭环

未发现可执行 P0–P3 代码问题。

Verification pass 发现 `docs/specs/0004-snapshot-import.md` 仍引用迁移前的 JavaScript 路径。该文档路径已在本次提交中更新为 `.ts`，源码与测试调用者也已无旧 import。

审查额外确认：

- Tree guard 的 descriptor 读取调整没有改变 JSON、普通对象或 null-prototype 对象的接受与拒绝边界。
- Raw scope 只存在于未授权中间模型；policy binding 生成的新对象是后续摘要、计划和 external link 的唯一 scope 来源。
- Candidate payload 的显式字段复制发生在 exact-key 校验之后，没有丢失合法字段或放入未知字段。
- `required()` 测试 helper 会在缺失值时立即失败；错误 predicate 比迁移前更严格，没有弱化或删除断言。

## 验证证据

- `npm run typecheck`：通过。
- Snapshot preview/domain/apply：51/51 通过。
- Import batch、journal import 与 crash recovery：16/16 通过。
- 扩展定向闭包：71/71 通过。
- `npm test`：229/229 通过，0 fail、0 skipped。
- 旧实现与新实现共 35 个差分场景：0 mismatch。
- `git diff --check`：通过。
- 未发现 `any`、双重断言、TypeScript ignore、non-null escape、测试 `.skip/.todo/.only`、本地绝对路径、凭证或旧目标 `.js` import。

## 剩余风险

- 本次没有调用真实 GitHub 或 Linear endpoint；网络读取边界不在 #22 变更范围内，现有 provider inspection 回归包含在全量测试中。
- 带状态的 JavaScript Proxy 不提供稳定输入快照；远程 JSON 路径不会产生 Proxy，现有 guard 对 Proxy 的限制与迁移前一致。
- Windows 工作树继续显示 LF 到 CRLF 的提示，但没有 whitespace error 或提交内容异常。

## 结论

Issue `#22` 保持了 Snapshot Import 的安全与确定性契约，删除了 fixture 声明覆盖，并建立了可由后续 Runner、Server 与 CLI 迁移复用的 strict TypeScript 基线。
