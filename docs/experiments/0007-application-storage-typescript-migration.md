# 实验 0007：Application 与 Storage TypeScript 迁移

## 实验卡

- 决策：能否在不改变 journal schema、import contract、写入顺序和故障语义的前提下，把 application service 与 file journal 迁移到 strict TypeScript。
- 假设：应用层拥有窄 `EventJournal` port、journal replay 保持 `unknown`、写入使用语义类型，可以同时建立编译期门禁并保留运行时防线。
- 反证：必须依赖 `any` 或类型断言；legacy/batch 混合重放、queue、rollback、fence、streaming 预算或原子提交行为发生变化。
- 指标：类型检查、直接测试、snapshot/runner/crash 回归和全量测试全部通过；独立审查无行为回退；不产生 JavaScript。
- 边界：迁移 canonical JSON、import policy/plan/batch、TaskSealService、FileEventJournal 及直接测试；snapshot importer、provider、runner 与 CLI 只更新 import。

## Red

完成约定文件改名和 import 更新后，首次 `npm run typecheck` 失败并产生约 455 条诊断，覆盖 `unknown` 输入、可选构造参数、journal/service contract、Node 错误收窄、nullable 状态和测试 fixture 边界。

## Green

- canonical JSON 与 import policy/plan/batch 从 `unknown` 经 guard/normalizer 形成稳定类型，schema、排序、digest 与 receipt 行为保持。
- `EventJournal` 由 application 层拥有：`readAll()` 返回不可信记录，`append()` 接受 canonical event，`commitBatch()` 保持可选能力。
- Service replay 只把合法 record 的 `import.batch` 路由到 batch validator，其余值继续交给领域运行时校验。
- 泛型 single-writer queue 在前一次 rejection 后可继续调度；attempt reservation、recovery、内存后提交和 unknown-outcome fence 保持。
- File journal 保留流式 scanner、CRLF、3 MiB batch、4 MiB record、legacy spool、同目录原子替换、文件模式继承及提交前后错误分类。
- 未迁移的 snapshot fixture 由最小 test-support 声明复用现有导出类型；没有复制生产 runtime schema。

## 验证证据

- `npm run typecheck`：通过。
- 7 个直接 TypeScript 测试文件：42/42 通过。
- Snapshot、runner 与 crash 定向回归：57/57 通过。
- `npm test`：212/212 通过，0 skipped。
- `git diff HEAD --check`：通过；仅有 Windows working-copy 的 LF/CRLF 提示。
- 两轮独立只读代码审查未发现 P0–P3 问题。
- 未发现 `any`、类型忽略、断言绕过、旧运行时 import、本地绝对路径、凭证或生成 JavaScript。

## 结论

支持假设。Application 与 storage 已进入 strict TypeScript，外部持久数据仍通过运行时 validator，journal 的资源预算、原子边界和失败恢复语义没有变化。
