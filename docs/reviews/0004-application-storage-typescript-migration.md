# 审查 0004：Application 与 Storage TypeScript 迁移

## 状态

通过。对应 GitHub Issue `#14`；审查对象是 canonical JSON、import policy/plan/batch、TaskSealService、EventJournal port、FileEventJournal、显式 import 和直接测试。

## 独立审查范围

进行了两个互相独立的只读 pass：

1. 架构与一致性 pass：类型所有权、unknown replay、schema/digest、queue/recovery/fence、streaming 预算、spool、原子提交和错误分类。
2. Backend pass：strict TypeScript、rollback、receipt 幂等、fault injection、测试强度、类型绕过和 test-support 声明边界。

另由独立 verification pass 执行类型检查、定向测试、全量测试、diff 与敏感信息扫描。

## Finding 与闭环

两轮审查均未发现 P0–P3 可执行问题。交付前同步修正了架构与 snapshot 规格中迁移前的 `.js` 文件名。

## 验证证据

- `npm run typecheck`：通过。
- 7 个直接 TypeScript 测试文件：42/42 通过。
- Snapshot、runner 与 crash 定向回归：57/57 通过。
- `npm test`：212/212 通过，0 skipped。
- `git diff HEAD --check`：通过；仅有 Windows working-copy 的 LF/CRLF 提示。
- 未发现旧目标 `.js` import、双 basename、生成 JavaScript、`any`、TypeScript ignore、类型断言、本地绝对路径或凭证。

## 剩余风险

- `test-support/snapshot-import-fixtures.d.ts` 是未迁移 JS fixture 的临时最小声明；未来迁移 snapshot importer 时应把 fixture 一并改为 TypeScript 并删除该声明。
- 本次未验证真实 Codex App Server、真实断电 durability 或多进程 writer；这些不属于行为不变迁移范围。

## 结论

Issue `#14` 已建立可复核的 application/storage TypeScript 边界，并保留既有 journal、queue、replay、rollback 与 fence 语义，可以进入发布审查。
