# ADR 0001：以 Canonical Event Plan 和原子 Journal Batch 实现 Snapshot Import

## 状态

Accepted for T08 implementation

## 日期

2026-07-26

## 背景

TaskSeal 的 provider inspection 已输出 canonical event snapshot，领域状态由事件重放产生，TaskSealService 是 journal 的唯一写入口。

直接导入仍有四个未解决边界：

1. `work_item.created` 无法表达同一 provider object 的后续编辑。
2. 已有 WorkItem 无法添加第二个 ExternalLink。
3. GitHub 与 Linear 同时提供标题时没有字段归属规则。
4. JSONL journal 逐事件追加无法保证一个 snapshot 的多事件原子性。

这个决策必须同时保留领域审计、确定性重放、preview-only 回退和未来 provider 扩展能力，但当前阶段不需要通用插件市场、远程数据库或分布式事务。

## 决策驱动因素

- Provider payload 不能绕过 canonical domain invariants。
- 同一 snapshot 重试必须幂等；provider 编辑必须成为新事实而不是 create 冲突。
- 一个 WorkItem 可以关联多个 provider object，但不能产生隐式 last-write-wins。
- 人工确认的计划必须与实际提交内容和提交前 Workflow 完全绑定。
- journal 失败或进程退出不能留下可见事件前缀。
- 旧 journal 不做破坏性迁移。
- 首版应保持模块窄小，能在第二个 provider 证据出现后继续提取插件契约。

## 候选方案

### A. Canonical Event Plan + ExternalLink mapping + ImportBatchRecord

流程：

```text
ProviderSnapshot
  → deterministic ImportPlan
  → canonical events
  → atomic ImportBatchRecord
  → Workflow replay
```

- Provider object mapping 作为 ExternalLink 的领域状态持久化。
- Provider update 产生 `external_link.observed`，字段管理者才可追加 `work_item.updated`。
- Preview 纯函数生成 planDigest 和 baseWorkflowDigest。
- Plan 同时绑定 versioned ImportPolicy 派生的目标 PolicyBinding/digest；apply 在写队列内用同一 normalizer 重新校验当前 capability 和允许 scope。
- Apply 先模拟全部 canonical events，再用一个 journal batch record 原子提交事件和回执。

优点：

- 保留现有事件溯源和领域不变量。
- 映射与 WorkItem 生命周期放在同一事实模型中，查询和重放一致。
- Preview、审批、apply 和重试边界可独立验证。
- Storage transaction envelope 不污染 domain event 语义。

代价：

- 需要新增三个 domain event/扩展、纯 importer 和 batch journal contract。
- File journal 的 batch commit 需要 staged whole-file replace，写放大可接受但不适合大规模生产。
- 未来若多个 bounded context 共用 provider object，可能需要把 mapping 提升为独立 aggregate。

### B. 直接用 ProviderSnapshot upsert WorkItem

流程：

```text
ProviderSnapshot → mutable WorkItem projection
```

优点：

- 实现代码最少。
- Provider update 看起来像普通字段覆盖。

缺点：

- 绕过 `applyEvent`，journal 无法解释状态来自哪些外部事实。
- 多 provider 标题会退化为处理顺序或最后写入者获胜。
- AcceptanceDecision 等字段容易被过宽 upsert 误改。
- 重试、冲突、审计和重启重放需要另造一套规则。

结论：拒绝。它破坏 TaskSeal “Agent 完成声明必须由证据与事件复核”的核心定位。

### C. 独立 Import/Mapping Aggregate，再投影为领域事件

流程：

```text
ProviderSnapshot
  → ImportAggregate / MappingLedger
  → canonical events
  → Workflow
```

优点：

- 能独立表达跨租户映射审批、冲突工单、重试状态和多目标投影。
- 适合未来大量 provider、Webhook 和异步队列。

缺点：

- 当前只有本地单进程、两个 read provider，尚无第二套真实写同步模式。
- 引入双重状态、跨 aggregate 一致性和更多恢复路径。
- ExternalLink 仍然需要领域级关联，导致首版重复存储 mapping。

结论：暂缓。出现多租户、一个 provider object 合法投影到多个 bounded context，或导入审批需独立长生命周期时重新评估。

## 决策

采用方案 A。

### 领域边界

- `ProviderObjectKey` 是外部对象的稳定身份，并在 Workflow 全局唯一。
- `ExternalLink` 保存 mapping、最后 SourceRevision、裁剪后的 observation 和 `managedFields`。
- Import mapping 显式声明 ExternalLink 的 managedFields；provider 类型和导入顺序都不会自动授予字段管理权。
- 新建 WorkItem 可以用 provider 标题建立初始值，但只有显式管理 title 的 link 才能驱动后续 title 更新。
- requiredEvidence、状态、Attempt、Artifact、Evidence 和 AcceptanceDecision 不由 Issue/ExternalLink 元数据更新；PR/Check fact 仍通过既有 artifact/evidence canonical events 导入。
- Provider 编辑追加 `external_link.observed`；只有 link 管理 title 时，才在同一 batch 内追加 `work_item.updated`。

### 应用边界

- `previewSnapshotImport` 是无 I/O 纯函数。
- ImportPlan 绑定 snapshotDigest、mappingDigest、policyDigest、baseWorkflowDigest 和确定性 canonical events。
- baseWorkflowDigest 首版故意覆盖完整 canonical Workflow；这会让无关 WorkItem 的并发写也使计划 stale，但契约更简单且不会误提交，后续有真实并发压力时再收窄为 target precondition。
- `applySnapshotImport` 必须收到调用方确认的 expectedPlanDigest。
- 已有 planDigest receipt 优先于 stale 检查，用于解决“提交成功但响应丢失”的幂等重试。
- Commit 结果未知时 service 必须 fenced，除 health/status 外在重新 open/replay 前拒绝全部读写，避免暴露或继续使用旧内存。
- 首版没有 force、ignore-conflict 或隐式 rebase；Workflow 变化后必须重新 preview。

### 存储边界

- ImportBatchRecord 是 journal transaction/audit envelope，不是 domain event。
- 一个 batch 包含可重算 planDigest 的完整语义材料、actor、全部 canonical events 和审计摘要；replay 在应用前还要验证当时的 baseWorkflowDigest。
- File journal 用同目录临时文件写入“原 journal + 完整 batch”，fsync 后原子 replace。
- commit 前失败保持原文件不变；commit 后失败通过 planDigest 恢复。
- 普通 append 与 batch commit 共用 TaskSealService 单进程 write queue。
- 首版只承诺经平台探针验证的进程崩溃/响应丢失原子性，不承诺断电 durability；不支持原子 replace 时 apply 保持关闭。

## 失败边界

| 边界 | 责任 |
| --- | --- |
| Provider schema、scope、revision 不可信 | Connector/inspection 拒绝或生成不可导入 snapshot |
| Mapping、对象唯一性、乱序与内容冲突 | Preview 产生稳定 conflict/skip code |
| 字段管理权、before 值和领域前置条件 | Domain event validation |
| 计划被修改或 Workflow 已变化 | TaskSealService 在任何 journal I/O 前拒绝 |
| Batch 写入失败 | Journal 保证原文件不变或完整 batch 可恢复 |
| Batch replay 失败 | Service 报 `JOURNAL_CORRUPT`，不暴露部分内存状态 |
| 外部系统写回 | 不属于 snapshot import capability |

## 兼容与迁移

- ProviderSnapshot v1 保持 display/内存重放，只拒绝 import；重新 inspect 可生成 v2。
- 现有 inspect 默认保持 v1；v2 需要显式 snapshot version 和 `provider|none` title management，禁止隐式字段权威。
- Legacy bare domain events 继续逐条 replay。
- Legacy upcaster 只根据历史 provider/externalId 为 GitHub/Linear Issue 生成稳定对象身份，不猜 scope 或字段管理权；一次 expected revision 为空的 v2 baseline observation 用显式 mapping 补齐这些字段。
- 新 batch 与 legacy events 可以出现在同一 journal。
- 不重写或删除历史事件。

## 后果

正面：

- `#4` 可以独立实现纯 preview；`#5` 可以在不改变 provider read client 的权限前提下实现 apply。
- 多 ExternalLink 和 provider edit 有明确、可审计的 canonical 语义。
- ImportReceipt 同时解决人工审批绑定和未知提交结果恢复。
- 未来 Control Room 可以直接投影 plan、conflict、receipt 和 provider freshness。

负面：

- 本地文件每次 batch commit 都要重写，journal 增长后性能会下降。
- managedFields 首版只支持 title，不能表达复杂双向字段同步。
- 单进程约束必须显式保持；并发进程仍可能破坏文件级一致性。
- v1 snapshot 需要重新读取才能导入。

## 回退

如果 batch 原子性、SourceRevision 或字段管理权的测试门禁未通过：

- 保持 apply capability 关闭；
- 继续提供现有 read-only inspection 和新 preview；
- 不修改旧 journal；
- 不降级为逐事件 append 或 direct upsert。

## 重新评估触发条件

满足任一条件时创建新 ADR：

- journal 进入数据库或需要多进程/多节点并发写；
- Provider 没有可排序 revision，但业务必须自动合并；
- 一个 provider object 需要合法关联多个 bounded context；
- 多个 provider 需要管理 title 以外的同一字段；
- Import approval 形成独立、长生命周期工作流；
- 第二个真实 provider 证明需要稳定插件 SDK。
