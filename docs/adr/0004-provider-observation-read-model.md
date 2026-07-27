# ADR 0004：Provider Observation 使用独立有界 JSON 读模型

- 状态：已接受
- 日期：2026-07-27
- 决策范围：GitHub Issue `#23`、后续 `#24` 与 `#29` 的读侧边界

## 背景

TaskSeal 已能从 GitHub、Linear 与 Gitee 生成裁剪 snapshot，也能对 GitHub/Linear snapshot 进行 preview 和受控 atomic apply。但这些结果只存在于单次命令返回或 import receipt 中，Control Room 无法回答：

- 哪些 Provider 目标已经配置；
- 最近一次检查是否 scope mismatch 或 sample missing；
- snapshot 是否可用；
- 同步是否失败；
- 哪个结果更新，晚返回的旧请求是否覆盖了它。

现有 `.taskseal/events.jsonl` 是 canonical Workflow journal。`TaskSealService.open()` 会把其中所有非 import batch 记录交给领域 `applyEvent()`；把 observation 混入该文件会同时污染业务恢复协议和验收不变量。

## 决策

### 1. Observation 是 application-owned read model

ProviderObservation 不属于 DomainEvent，也不修改 Workflow。它只保存展示所需的白名单摘要：

- provider；
- configured target 与 observed scope；
- 五态 status；
- operation start/completion time；
- source revision 的 type/id/time/digest；
- snapshot、mapping、plan digest；
- missing evidence；
- allowlist diagnostic code；
- import resolution。

不保存 raw payload、完整 snapshot/fact/plan、标题、URL、外部对象 key、凭证、错误 message/stack/cause 或 actor。

### 2. 使用独立、有界、原子替换的 JSON snapshot

文件为：

```text
.taskseal/provider-observations.json
```

选择 JSON snapshot，不选择 JSONL：

- 这是每个 configured target 的最新状态，不是不可变审计日志；
- 写入前即可比较 freshness 并忽略 stale 结果；
- whole-file snapshot 可直接限制目标数、数组数和总字节；
- API 和重启恢复不需要 replay/compaction。

写入使用同目录单一确定性 `wx` temporary slot、file sync、atomic rename 与 best-effort directory sync。rename 前失败保留旧文件；若 temporary 已创建则保留这一个 mode 0600、最大 256 KiB 的 orphan，后续写入失败关闭，直到操作者确认状态目录仍是原工作区内真实目录并移除 orphan。失败路径不按字符串 path 自动清理，因为目录可能已被换成指向工作区外的 Junction；单一 slot 同时把残留资源限制为一份。rename 后结果未知会让当前 read-model 实例进入 reopen-required。损坏、额外字段、重复 identity 或超限不会被跳过或自动清空。

state directory 必须是 canonical workspace root 下的直接真实目录。存储拒绝 symlink/Junction、目录 identity 漂移与非普通目标文件；读取最多获取 256 KiB + 1 字节，不能把 `stat` 当成读取上限。这样 workspace 内的重定向或并发扩容不能诱导宿主在项目外写入或无界读取。

### 3. 身份绑定 configured target

当前记录身份为：

```text
provider + configuredTarget.key
```

不能只使用 Provider 返回的 observed scope。scope mismatch 正是“配置目标”和“实际返回 scope”不同；如果按 observed scope 建卡，会把错误结果伪装成另一个正常目标。

Linear configured target 使用 workspace/team 配置引用；成功读取后的 Organization/Team UUID 单独放在 observed scope。

repository target 与 observed scope 必须精确相等。Linear 的名称引用与 UUID scope 无法按字符串相等，因此 production inspection 使用同一次读取的 ProjectConfiguration 同时构造 stable target 并驱动 connector；connector 完成 workspace/team 校验后，才把已验证 UUID scope 与该引用绑定。无法证明 provider/kind/shape 或 repository 精确匹配时，投影 `PROVIDER_OBSERVATION_SCOPE_MISMATCH`，且不保留 snapshot digest/revision。

### 4. 用操作开始版本拒绝乱序覆盖

每次 operation 开始时固定 `startedAt`。同一 identity：

- 较晚 startedAt 替换当前值；
- 较早 startedAt 返回 ignored-stale；
- 相同 startedAt + 相同内容幂等；
- 相同 startedAt + 不同内容失败关闭。

不使用 completion time 或文件追加顺序判断 freshness。这样较早请求即使最后完成，也不能覆盖较晚开始的结果。

输入时间只接受严格 RFC3339 date-time，并在 freshness 与 observation digest 前规范为 UTC millisecond ISO 字符串。等价时区表达因此幂等；locale date、注释文本或非法日历日期不会进入磁盘/API。

### 5. Observation 故障与业务结果隔离

Provider inspection、snapshot preview 和 snapshot import 通过 application coordinator 记录 observation：

- 成功结果先由原 operation 确认，再投影摘要；
- 失败只记录安全 code，并重新抛出同一个业务错误；
- observation projection/write 失败不会替换 operation 的成功或错误；
- import observation 发生在 `TaskSealService.applySnapshotImport()` 完成或拒绝之后，不进入 canonical commit 事务区间。

`ObservedSnapshotImportFacade` 是 preview/apply 的 production application composition：它必须持有 configured target 到 resolved scope 的显式绑定，在 coordinator 的 `execute` 中先校验 snapshot provider，并对规范化 plan 做 provider + scope 精确比较，再调用现有纯 preview 或 `TaskSealService` apply port。Linear runtime 只从该 configured target 最新 `snapshot_ready` observation 恢复 binding；没有 binding 时失败关闭。Service 不依赖 façade/coordinator，因此不存在递归，也不把 read-model I/O 带入 canonical write queue。跨 Provider 或 foreign Team plan 在 service 前拒绝，不能先提交再静默丢失 observation。当前不因此新增 CLI/HTTP 写入口。

Control Room 启动需要可用的 observation query，因此损坏 store 会在 listen 前拒绝启动；这不会 fence Workflow service，也不会阻止独立的 `taskseal run` 或 Provider read。

### 6. v1 明确为单 writer

v1 command port 只保证同一个 read-model 实例内的写入串行。多个进程同时 whole-file replace 可能产生 lost update，因此当前不声明 multi-writer 安全。

Query 每次重新读取有限 snapshot，使已经运行的 Control Room 可以看到另一个 CLI 进程完成的原子替换。若真实使用需要并发多 writer，优先把写命令集中到 Control Room，或引入具备事务/锁语义的持久化；不能把 rename 当成跨进程并发控制。

## 备选方案

### 写入 canonical event journal

可以复用已有存储，但会让 read-side 状态进入领域 replay，并把 Provider 诊断故障升级为 Workflow journal corruption。

不采用。

### 独立 JSONL observation journal

追加简单，也更接近历史时间线。但 #23 只需要最新状态，JSONL 会新增增长上限、compaction、重复 replay、partial tail 和跨版本迁移协议。

不采用；#29 的 operation journal 保持独立，不复用本文件。

### 内存状态

实现最小，但重启后丢失，且 CLI 与 Control Room 进程无法共享结果。

不采用。

### 立即引入 SQLite 或数据库

能处理多 writer、查询和迁移，但当前验证只有本地单用户、最多 64 个 target；新增依赖与部署复杂度超过本切片收益。

不采用。达到 multi-writer 或远程平台触发条件后重新决策。

## 影响

- Control Room 获得 persistent-only `GET /api/providers`，只返回脱敏 projection，且 `cache-control: no-store`。
- Demo 模式与其他 HTTP method 不提供 Provider API 写入口。
- 实际 CLI inspection 会更新 observation 文件，但仍不修改 canonical event journal，也不写外部 Provider。
- #24 可直接消费五态、scope、revision、digest 与 missing evidence。
- #29 可以在独立 operation journal 完成后合并审批/提交状态，而不用改变 #23 的 read/write 边界。
- v1 不保证多进程并发写，属于显式限制而不是隐含能力。

## 验收门禁

1. 五态、安全诊断映射与白名单字段测试通过。
2. stale/idempotent/ambiguous freshness 测试通过。
3. 重启、损坏、超限、Junction 拒绝、有界竞态读取、rename 前失败和 rename 后未知结果测试通过。
4. inspection、真实 preview、真实 apply/idempotent/rejection 与 sink failure 不改变业务结果。
5. `GET /api/providers` 成功与安全 503 合同通过，且没有写 method。
6. observation store 损坏时 Control Room 不 listen；独立 inspect 仍返回原 Provider 结果。
7. 全量测试和独立后端/安全审查无剩余 P0–P3。

## 参考

- [规格 0007：Provider Observation 读模型与只读 API](../specs/0007-provider-observation-read-model.md)
- [Snapshot Import ADR](0001-snapshot-import-contract.md)
- [连接器边界](../architecture/connectors.md)
