# 审查 0003：领域与 Dashboard TypeScript 迁移

## 状态

通过。对应 GitHub Issue `#13`；审查对象是领域类型、canonical event 联合、运行时 validator、Dashboard projection、显式 import 和直接测试。

## 独立审查范围

进行了两个互相独立的只读 pass：

1. 架构与领域 pass：类型所有权、九类事件穷尽分发、运行时边界、错误优先级、Legacy/Rich ExternalLink、Dashboard 输出与依赖方向。
2. Backend pass：strict TypeScript、幂等行为、nullable 边界、测试断言、类型绕过与迁移前后事件变异差分。

另由独立 verification pass 执行类型检查、定向测试、全量测试、diff 和敏感信息扫描。

## Finding 与闭环

| Finding | 处理结果 |
| --- | --- |
| Snapshot 规格仍引用迁移前的 `src/domain/workflow.js` | 更新为 `src/domain/workflow.ts`。 |

修订后未发现剩余 P0–P3 问题。

## 验证证据

- `npm run typecheck`：通过。
- 领域与 Dashboard 直接测试：25/25 通过。
- Snapshot domain/preview/apply 回归：51/51 通过。
- `npm test`：212/212 通过，0 skipped。
- 876 组合法事件字段变异的迁移前后差分为零。
- `git diff HEAD --check`：通过；仅有 Windows working-copy 的 LF/CRLF 提示。
- 未发现 `any`、类型断言绕过、TypeScript ignore、旧运行时 import、path alias、生成 JavaScript、本地绝对路径或凭证。

## 剩余风险

- 尚未迁移的 JavaScript 消费者仍只受运行时 validator 保护；它们将在后续 migration tickets 中逐步进入 strict 门禁。
- 本次联合类型与运行时 validator 同文件共置，但两者仍需在新增事件时同步更新；穷尽分发和测试是当前防漂移门禁。

## 结论

Issue `#13` 已建立可复核的领域 TypeScript 边界，并保持现有运行时兼容，可以进入发布审查。
