# 审查 0002：Atomic Snapshot Apply

## 状态

通过。对应 GitHub Issue `#5`；审查对象是 snapshot import 的 application、domain、journal、health 状态、测试与实验记录。

本次实现只提交 TaskSeal 本地 journal，不开放 CLI/HTTP apply，也没有对 GitHub、Linear 或其他 provider 执行写入。

## 独立审查范围

进行了两个互相独立的只读 pass：

1. 架构与领域 pass：plan/event 同构、依赖方向、单写队列、原子边界、重放、兼容与失败状态。
2. Backend 与安全 pass：policy TOCTOU、tamper、幂等、crash window、资源预算、文件句柄、spool 生命周期和低 heap 恶意输入。

另由独立 verification pass 执行完整测试、类型检查、diff 与敏感信息扫描。

## Finding 与闭环

| Finding | 处理结果 |
| --- | --- |
| Action summary 可与实际 event 语义脱钩 | 使用固定 action kind、reason、target 与 event type 映射；非 skip/conflict action 必须且只能对应一个 event。 |
| Plan/Batch 可通过排序、warning、conflict 或 schema 宽松性伪造摘要 | 对完整 schema、canonical 顺序、投影与 digest 重算做同构校验。 |
| 原子 replace 探针失败会连带关闭普通 Runner append | 探针只控制 batch commit；普通 append 保持可用，写入开始后的失败返回结果未知并 fence service。 |
| Commit 结果未知后旧实例仍可能继续工作 | 所有后续读写失败关闭；persistent health 返回 `503` 和 fence 原因，必须重新 open/replay。 |
| Snapshot、Workflow 或 Receipt 引用可被调用方修改 | 所有公共读取返回隔离副本，持久 Receipt 保持不可变。 |
| Canonicalization 可能先构造超大对象再检查预算 | ImportPlan 与 ImportBatch 在规范化前检查深度、宽度与 JSON 字节预算。 |
| Journal 路径、探针或临时文件处理存在 TOCTOU/错误归类风险 | 构造配置私有固定；source `ENOENT` 只在初次 open 解释为空；spool 使用同一 `wx+` 句柄回读并以 `0600` 创建。 |
| 全文件/全行读取可被超大输入触发 OOM | 改为 chunk 读取；ImportBatch 上限为 3 MiB，任意 journal 行绝对上限为 4 MiB，超限在整体回读与 JSON parse 前拒绝。 |
| 无界 legacy 兼容与小堆内存安全无法同时成立 | 明确选择 4 MiB compatibility limit；3–4 MiB legacy 使用 spool 并可重放，超过上限要求离线迁移，不在服务进程内猜测 payload。 |
| 普通 append 能写出 reader 随后拒绝的超限记录 | append 在目录或文件写入前应用相同的 4 MiB 上限，并拒绝通过普通路径写入保留的 `import.batch` record type。 |
| Legacy envelope 额外字段或超长 ID 被识别器误拒绝 | 删除 storage 的领域 envelope/type 判定；上限内由真实 JSON parser 与 Domain replay 决定，额外字段和 513 字符 ID 重开测试通过。 |
| CRLF 的 `\r` 被错误计入 batch 边界 | 流式累加器延迟处理结尾 `\r`，精确 3 MiB CRLF 通过，增加 1 byte 拒绝。 |
| 合法 conflict tuple 未进入 apply 阻塞路径 | 补齐 `FIELD_AUTHORITY_CONFLICT` 映射，并用真实 preview → apply 集成测试验证零提交。 |

修订后，两轮独立复核均未发现剩余 P0–P2 问题。

## 验证证据

- `npm test`：TypeScript strict/noEmit 检查通过；212 tests passed，0 failed。
- 真实子进程在 replace 前退出只保留旧 journal，在 replace 后退出只暴露完整 batch。
- 64 MiB batch 与未分类坏行在 24 MiB V8 heap 下稳定返回 `JOURNAL_CORRUPT`，没有 OOM。
- 精确 4 MiB legacy 行可读，增加 1 byte 失败关闭；额外字段、超长 ID 和 3 MiB 长标题可重开。
- 无效 Unicode escape、双冒号、伪装 canonical envelope、无效 payload 和超限合法 legacy 均在整体回读前拒绝。
- `git diff --check` 无 whitespace error；仅存在 Windows working-copy line-ending 提示。
- 全部变更文件未发现开发者机器绝对路径、凭证模式或生成物。

## 剩余风险

- 只验证单进程 writer 与当前本地文件系统上的进程崩溃/响应丢失，不承诺断电 durability、网络文件系统或多进程锁。
- 超过 4 MiB 的旧 journal 行需要离线迁移；本原型不提供自动迁移器。
- 首版没有自动 undo；纠错必须追加后续补偿事件，不能删除审计事实。
- CLI/HTTP apply、人工审批入口和 provider 外部写回仍是后续独立切片。

## 结论

Issue `#5` 的本地 atomic snapshot apply、不可变 receipt、幂等重试、结果未知恢复和确定性 replay 已形成可复核闭环，可以进入发布审查。
