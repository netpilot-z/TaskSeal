# 审查 0001：Snapshot Import 契约

## 状态

通过。对应 GitHub Issue `#3`；审查对象是：

- `CONTEXT.md`
- `docs/specs/0004-snapshot-import.md`
- `docs/adr/0001-snapshot-import-contract.md`
- `docs/architecture/connectors.md`

本次只审查领域与技术契约，没有实现 production import，也没有对 GitHub、Linear 或其他 provider 执行写入。

## 独立审查范围

进行了两个互相独立的只读 pass：

1. 架构与领域 pass：术语、不变量、字段管理权、事件 schema、模块所有权、依赖方向、兼容与 #4/#5 可实现性。
2. Backend 与安全 pass：plan/receipt 幂等、授权 TOCTOU、batch 原子性、crash recovery、重放完整性、不可信输入、URL/scope 和失败门禁。

## Finding 与闭环

| Finding | 处理结果 |
| --- | --- |
| Batch 缺少完整 plan material，replay 无法证明 events 来自获批计划 | Batch 保存 mapping/policy binding、actions、events、conflict/warning codes；replay 重算 policyDigest、planDigest、event IDs 与 summary。 |
| Replay 未验证计划形成时的 Workflow | 首次 batch 应用前验证 baseWorkflowDigest；完全相同的 seen batch 先按 record digest 幂等跳过。 |
| Commit 已成功但响应未知时旧 Service 可继续读写 | Service 立即 fenced；除 health/status 外全部读写返回 `SERVICE_REOPEN_REQUIRED`，直到重新 open/replay。 |
| Preview 后 scope/capability 撤销仍可 apply | 定义 ImportPolicy v1 与目标 PolicyBinding；apply 在 write queue 内从可信 provider 重建并比较 policyDigest。 |
| Legacy ExternalLink 无 SourceRevision、scope 或字段管理权 | Domain legacy upcaster 只补稳定身份；一次显式 `expectedRevisionId: null` baseline 补齐 scope、managedFields 和 observation。 |
| ImportReceipt 不可变与 replay 来源标记冲突 | Receipt 只保存不可变事实；本次取得方式放在非持久化 response metadata。 |
| `fsync + replace` 被误解为跨平台断电承诺 | 首版只承诺经探针验证的进程崩溃/响应丢失原子性；不支持的平台保持 preview-only，断电 durability 另立规格。 |
| ExternalLink URL 未绑定 provider scope | GitHub/Linear 使用 provider-specific origin/path/scope 校验，拒绝 userinfo、端口、query 和 fragment。 |
| Snapshot 资源限制不可测试 | 固定原文、深度、facts、字段、字符串、URL 和 mapping 上限；plan 也有独立上限。 |
| v2 snapshot 没有兼容生成入口 | 保留 inspect v1 默认，新增显式 snapshot version 和 `provider|none` title management。 |
| 数据流被误写成源码依赖 | 文档分别描述运行时数据流与源码依赖；Domain 不依赖 Application/Storage，legacy upcaster 归 Domain。 |
| ImportPolicy schema 不足以同构重建 | 固定 versioned schema、scope key、排序、去重、未知字段拒绝和共用 binding builder。 |

修订后，两轮独立复核均未发现剩余 P0–P2 问题。

## 验证证据

- `npm test`：114 tests passed，0 failed。
- 全部 12 个新增 JSON 示例可被 JSON parser 解析。
- `git diff --check` 无 whitespace error；仅存在仓库既有的 Windows line-ending 提示。
- 变更文件扫描未发现开发者机器本地绝对路径。
- 变更文件扫描未发现 GitHub/Linear/OpenAI 凭证模式。

## 剩余风险

- `#4` 必须用 TDD 实现 v2 snapshot 与纯 preview；本审查不把规格通过等同于实现通过。
- `#5` 必须用真实目标平台探针、故障注入和重启测试证明 atomic batch contract；探针失败时不得开放 apply。
- 多进程 writer、断电 durability、字段管理权迁移、冲突 force 和 provider 外部写回仍明确不在当前范围。

## 结论

Issue `#3` 的本地规格、ADR 与独立安全审查证据已经完整，可以进入发布审查；`#4`、`#5` 的生产实现仍分别受各自测试与授权门禁约束。
