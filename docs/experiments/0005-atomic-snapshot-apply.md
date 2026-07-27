# 实验 0005：Snapshot 原子提交与重放

## 实验卡

- 决策：本地 JSONL journal 能否在不引入生产依赖的前提下，为一个 ImportPlan 提供可复核的原子 batch、结果未知恢复和旧事件兼容。
- 假设：同目录临时文件完整写入并 fsync 后执行 replace，可在当前 Windows 目标环境的进程异常边界上只暴露旧 journal 或完整新 batch；planDigest、baseWorkflowDigest、policyDigest 和完整 batch material 足以在重启时验证并恢复 ImportReceipt。
- 反证：replace 前退出留下部分 batch；replace 后退出无法重放完整 batch；重复 batch 再次应用事件；篡改 action/event/summary 仍能通过；探针失败导致普通 Runner journal 也不可写。
- 指标：真实子进程故障测试、apply/replay 契约测试、完整类型与回归门禁全部退出 0；无凭证、raw snapshot 或本地绝对路径进入 receipt/journal。
- 边界：单进程 writer、本地文件系统、进程退出与响应丢失；不承诺断电 durability、网络文件系统、跨进程锁或 provider 外部写入。

## 结果

支持假设。

### 原子可见性证据

执行：

```text
node --test test/event-journal-crash.test.js
node --test test/event-journal-import-batch.test.js
```

结果：

- 子进程在 `beforeReplace` 直接退出后，journal 保持旧字节或为空，没有 batch 前缀。
- 子进程在 `afterReplace` 直接退出后，重新打开 journal 只能读取一个完整 ImportBatchRecord。
- replace 前可注入失败保持 journal 字节一致；replace 后响应未知返回 `JOURNAL_COMMIT_OUTCOME_UNKNOWN`。
- 64 MiB 损坏 batch 在 24 MiB V8 heap 子进程中由 chunk 级预算稳定拒绝为 `JOURNAL_CORRUPT`，没有先缓存完整单行或发生 OOM。
- 3–4 MiB 的 legacy 大行使用权限为 `0600` 的临时 spool；其中含额外 envelope 字段或超长 ID 的合法 bare event 仍可读取和普通追加。
- 任意 journal 行采用 4 MiB 绝对上限；无效 JSON、伪装 canonical envelope、无效 payload 与原本领域可接受但超过上限的 legacy event 都会在整体回读前稳定拒绝为 `JOURNAL_CORRUPT`，避免由 storage 猜测领域 payload 合法性。
- 普通 append 在打开文件前执行相同的 4 MiB 上限，并拒绝通过普通路径写入保留的 `import.batch` record type，确保系统不会自行持久化下次无法重放的记录。
- 同目录 replace 探针失败时 batch apply 返回 `JOURNAL_ATOMIC_COMMIT_UNSUPPORTED`，普通 canonical event append 仍可用。
- 普通 append 一旦开始写入，再发生失败会返回结果未知并由 TaskSealService fence，避免以内存旧状态继续写。

### 计划、回执与重放证据

- apply 在单写队列内依次重验 plan schema/digest、可信当前 policy、blocking conflict、base workflow 和全部领域事件。
- action kind、reason、semantic target 与 event type 使用共享固定契约；actions、events、conflict/warning 投影必须保持 canonical 排序。
- ImportPlan 和 ImportBatch 在完整规范化前执行深度、宽度与字节预算；journal 在 JSON parse 前限制单条记录大小。
- 成功 batch 保存可重算 planDigest 的完整 material，并生成不含 raw snapshot 的不可变 ImportReceipt。
- 同一 batchId 与完整 record digest 重复时先幂等跳过；同 ID 异内容、首次 batch base 不匹配或任一事件无效均以 `JOURNAL_CORRUPT` 失败关闭。
- commit 结果未知后，persistent `/health` 返回 fenced 状态；其他 service 读写要求重新 open/replay。

### 完整门禁

```text
npm test
```

结果：TypeScript strict/noEmit 检查通过；212 项 Node tests 全部通过，0 failed。

## 结论与后续边界

Issue `#5` 的最快技术验证目标成立：TaskSeal 已具备 application 层 atomic snapshot apply、不可变 receipt、幂等重试和完整 replay。该能力默认关闭，只有注入可信 ImportPolicy provider 且目标 scope/capability 与获批计划一致时才能提交。

本实验没有开放 CLI/HTTP apply，也没有赋予 GitHub、Linear 或其他 provider 写权限。下一阶段可在独立 Issue 中增加人工审批入口；多进程 writer、断电恢复和生产数据库必须重新定义存储契约，不能沿用本实验结论直接声称支持。
