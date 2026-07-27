# 审查 0005：Provider TypeScript 迁移

## 状态

通过。对应 GitHub Issue `#15`；审查对象是 GitHub/Linear normalizer 与 read client、ProviderSnapshot 归一化契约、inspection v1/v2、Linear dry-run、JS consumer import 和直接测试。

## 独立审查范围

进行了三个互相独立的只读 pass：

1. 架构 pass：类型所有权、provider DTO 泄漏、unknown runtime guard、read/write capability、snapshot import 兼容和扩展名闭包。
2. Backend pass：HTTP/GraphQL 契约、scope、分页、凭证与错误脱敏、行为兼容和失败分类。
3. Verification pass：类型检查、provider/snapshot 定向测试、全量测试、diff 与测试计数复验。

## Finding 与闭环

### P2：未完成 GitHub Check 的错误语义回归

初始 guard 要求所有 Check 的 `completed_at` 为非空字符串，使合法 `status: "in_progress"`、`completed_at: null` 在生命周期判断前返回 `GITHUB_RESPONSE_INVALID`。

修复后 transport DTO 允许未完成态的 nullable `conclusion/completed_at`；先返回既有 `GITHUB_CHECK_INCOMPLETE`，只有完成态才收窄为非空字符串。补充了迁移前后错误码兼容回归。

### P2：畸形 Check conclusion 与 GraphQL errors 未完全失败关闭

初始 GitHub Check guard 允许任意 `conclusion`，可能把对象归一为 failed evidence；Linear 仅识别非空数组 `errors`，导致非数组 `errors` 与有效 `data` 并存时继续执行。

修复后 GitHub read client 与 normalizer 都要求完成态 conclusion 为非空标量；Linear 只要 envelope 自有 `errors` 字段，就必须先验证为数组。新增回归覆盖对象 conclusion 和字符串 errors。

两轮修复复审均确认原 P2 关闭，未发现新增 P0–P3。

## 验证证据

- `npm run typecheck`：通过。
- 7 个直接 TypeScript 测试文件：54/54 通过。
- Provider 与 snapshot import 契约定向回归：74/74 通过。
- `npm test`：229/229 通过，0 skipped。
- `git diff --check`：通过；仅有 Windows working-copy 的 LF/CRLF 提示。
- 未发现旧目标 `.js` import、双 basename、生成 JavaScript、`any`、TypeScript ignore、类型断言、本地绝对路径或凭证。

## 剩余风险

- Snapshot Import 和其测试 fixture 仍为 JavaScript，临时声明文件继续存在；GitHub Issue `#22`（T12.7）负责独立迁移并删除声明。
- 本次没有调用真实 GitHub/Linear endpoint；外部样本的成功语义已由迁移前实验验证，本次只验证行为兼容与边界收窄。
- Gitee、飞书和通用插件契约不属于本次迁移，分别由 `#9`、`#10` 与 `#25` 跟踪。

## 结论

Issue `#15` 已建立可复核的 provider TypeScript 边界，保留 REST/GraphQL 运行时校验、scope、分页、凭证脱敏、snapshot digest 与 dry-run 零外写语义，可以进入发布审查。
