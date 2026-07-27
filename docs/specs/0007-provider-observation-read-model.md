# 规格 0007：Provider Observation 读模型与只读 API

## 状态

已确认，进入实现。对应 GitHub Issue `#23`。

## 目标

TaskSeal 需要把 Provider 检查、snapshot preview 和 snapshot import 的最新安全结果持久化为独立读模型，使 Control Room 能通过只读 API 判断每个已配置目标当前处于：

- `configured`
- `scope_mismatch`
- `sample_missing`
- `snapshot_ready`
- `sync_failed`

该能力只观察同步链路，不修改 Workflow、ImportPolicy、ImportPlan、ImportReceipt 或任何外部系统。

## 非目标

- 不实现 #24 的前端页面。
- 不投影 #29 的审批、提交、未知结果或对账 operation。
- 不新增浏览器写入口、Provider 写回、Webhook、事件总线、数据库、NestJS 或生产依赖。
- 不把 observation 写入 `.taskseal/events.jsonl`。
- 不保存 Provider raw payload、snapshot/fact/plan 全文、标题、URL、凭证、错误消息、stack、cause 或 import actor。
- 不在本切片解决多个进程同时写同一个 observation 文件；v1 明确使用单 writer，读取端支持跨进程刷新。

## 统一语言

### ProviderObservation

一次 Provider 操作的有限、脱敏结果。只保存投影所需字段，不是 canonical DomainEvent，也不是外部 Provider 的审计副本。

### ConfiguredTarget

操作者实际配置并发起检查的目标，是 observation 的稳定身份组成部分。身份使用 `provider + configuredTarget.key`，不能只使用 Provider 返回的 observed scope；否则 scope mismatch 会被错误地投影成另一张卡。

### ObservedScope

Provider 成功响应或已验证计划实际声明的 scope。它可以为空，也可以与 ConfiguredTarget 不同；不同时状态必须为 `scope_mismatch` 或安全失败。

### Freshness

一次操作开始时产生的 `startedAt`。投影按开始版本比较，而不是按完成或文件写入顺序比较；较早开始、较晚完成的请求不得覆盖较晚开始的结果。

## 数据契约

持久化文件固定为仓库相对路径：

```text
.taskseal/provider-observations.json
```

文件 envelope：

```json
{
  "schemaVersion": 1,
  "observations": []
}
```

每个 observation 具有以下白名单字段：

```json
{
  "schemaVersion": 1,
  "observationId": "sha256:...",
  "operation": "inspection",
  "provider": "github",
  "configuredTarget": {
    "kind": "repository",
    "key": "github:repository:owner/repository"
  },
  "observedScope": {
    "kind": "repository",
    "key": "github:repository:owner/repository",
    "parentKey": null
  },
  "status": "snapshot_ready",
  "startedAt": "ISO-8601 timestamp",
  "observedAt": "ISO-8601 timestamp",
  "sourceRevisions": [
    {
      "objectType": "issue",
      "id": "provider revision id",
      "occurredAt": "ISO-8601 timestamp",
      "contentDigest": "sha256:..."
    }
  ],
  "snapshotDigest": "sha256:...",
  "mappingDigest": "sha256:...",
  "planDigest": null,
  "missingEvidence": ["tests"],
  "diagnosticCode": null,
  "resolution": null
}
```

规则：

- `operation` 只允许 `configuration`、`inspection`、`snapshot.preview`、`snapshot.import`。
- `provider` 只允许当前 read-model 已知的 `github`、`linear`、`gitee`。
- `configuredTarget` 必须显式绑定 provider；Linear 使用配置坐标作为稳定目标，成功后把 UUID scope 放入 `observedScope`。
- `observedScope` 只保存 kind/key/parentKey，不保存名称、URL 或完整对象。
- `sourceRevisions` 只保存 object type 与 revision 的 id/time/digest，不保存 source object identity 或观察正文。
- snapshot、mapping 和 plan 只保存 canonical digest。
- `missingEvidence` 去重、排序并受现有 evidence key 上限约束。
- `diagnosticCode` 必须来自显式安全 allowlist；未知 code 归一为 `PROVIDER_OPERATION_FAILED`。
- `observationId` 是除自身外全部规范化白名单字段的 canonical digest。
- 所有时间只接受严格 RFC3339 日期时间并在比较和 digest 前规范为 UTC millisecond ISO 表示；locale date、注释文本与非法日历日期失败关闭。
- 所有对象 exact-key；所有数组必须是 dense 标准 data array；额外字段、accessor、自定义数组 prototype、非法时间、非法 digest、重复记录或超限都失败关闭。

## 状态映射

### 成功

- 配置 seed 或 `provider.health` 成功：`configured`。
- inspection 返回裁剪 snapshot：`snapshot_ready`。
- preview 成功：`snapshot_ready`，并保存 snapshot/mapping/plan digest。
- import 成功或幂等命中：`snapshot_ready`，并保存 plan digest 与 resolution。

### 失败

- `LINEAR_WORKSPACE_MISMATCH`、`LINEAR_ISSUE_TEAM_MISMATCH`、`GITEE_SCOPE_MISMATCH`、`GITEE_ISSUE_REFERENCE_MISMATCH`、`GITEE_ISSUE_URL_INVALID`、import scope mismatch：`scope_mismatch`。
- `GITHUB_NOT_FOUND`、`GITHUB_CHECK_NOT_FOUND`、`LINEAR_ISSUE_NOT_FOUND`、`GITEE_NOT_FOUND`：`sample_missing`。
- 其余安全 allowlist code：`sync_failed`。
- 未知、非法或过长 code：`sync_failed` + `PROVIDER_OPERATION_FAILED`。

只持久化诊断码，不持久化 `Error.message`、stack 或 cause。

## Freshness 与幂等

同一个 `provider + configuredTarget.key` 只保留最新 observation：

1. 新 `startedAt` 晚于当前值：替换。
2. 新 `startedAt` 早于当前值：返回 `ignored-stale`，文件不变。
3. `startedAt` 相同且 `observationId` 相同：返回 `idempotent`，文件不变。
4. `startedAt` 相同但内容不同：返回 `PROVIDER_OBSERVATION_VERSION_CONFLICT`，不得猜测顺序。

首次启动只为尚无 observation 的有效 Provider 配置写入 `configured`，不得用新的 configuration seed 覆盖已有 snapshot 或失败结果。

## 存储

选择有界 JSON snapshot，不选择 JSONL：

- 这是最新状态读模型，不是审计事件流。
- whole-file snapshot 能直接限制记录数和总字节，避免新增 compaction/replay 协议。
- 写入前即可拒绝 stale observation。
- API 和重启恢复不需要重放历史。

限制：

- 最多 64 个 configured target。
- 文件最多 256 KiB。
- source revisions 最多 100 条。
- missing evidence 最多 64 条。
- 通用字符串、ID、scope key 和诊断码均有独立长度限制。

存储写入使用同目录单一确定性 `wx` temporary slot、文件 sync、原子 rename 和 best-effort directory sync：

- rename 前失败：旧文件保持不变；若 temporary 已创建则保留一个 mode 0600、最大 256 KiB 的 orphan，后续写入失败关闭，直到操作者确认状态目录 identity 后移除 orphan。
- rename 后结果无法确认：store 进入 reopen-required 状态，当前实例不再写入。
- state directory 必须是 canonical workspace root 下的直接真实目录；symlink/Junction、目录身份漂移和非普通目标文件均失败关闭。
- 失败路径不得按未经重新绑定的字符串 path 删除 temporary file，以免目录换绑后删除工作区外同名文件；temporary 残留必须由单一 slot 保持有界。
- 文件读取使用 `limit + 1` 有界循环；`stat` 只用于提前拒绝，文件在检查后扩容也不会触发无界 `readFile`。
- 文件缺失：视为空读模型。
- JSON 损坏、schema/字段/数量/字节不合法：`PROVIDER_OBSERVATION_STORE_CORRUPT`，不得自动清空或跳过。

v1 command port 只保证同一 store 实例内串行写。Control Room 的 query port 每次 GET 都重新读取有限 snapshot，以看到其他 CLI 进程已经完成的原子替换。

## Application 协调器

新增 application-owned coordinator，包裹三类操作：

```text
inspection
snapshot preview
snapshot import
```

行为：

1. 在操作开始前固定 `startedAt` 与 ConfiguredTarget。
2. 成功后先对账 ConfiguredTarget 与 ObservedScope：GitHub/Gitee repository 必须精确相等；Linear inspection 由同一份配置快照完成配置引用校验并绑定已验证的 Organization/Team UUID scope。
3. 只从 typed snapshot/health/ImportPlan/ImportReceipt 投影白名单摘要。
4. 失败时只投影安全 code，然后重新抛出原始错误对象。
5. observation 写入使用独立队列，不进入 `TaskSealService` 的业务写队列。
6. observation 写失败不得改变 inspection/preview/import 的成功结果，也不得替换原业务错误。
7. import observation 必须发生在 `TaskSealService.applySnapshotImport()` 完成或拒绝之后，绝不能插入 canonical batch commit 的事务区间。

preview 继续保留现有纯函数；`ObservedSnapshotImportFacade` 是 production application caller 的异步 observed 入口，组合真实 `previewSnapshotImport()` 与 `TaskSealService.applySnapshotImport()`。façade 必须持有 configured target 到 resolved scope 的显式绑定，并在调用 preview/service 前校验输入 Provider，在提交前以规范化 plan 精确校验 provider + scope。Linear runtime 只从同一 configured target 最新 `snapshot_ready` inspection 提取 UUID binding；没有已验证 binding 时拒绝构造。底层纯函数和 service 端口继续用于规则/原子性测试，当前没有 preview/apply CLI 或 HTTP 写入口。

## HTTP API

Persistent Control Room 新增：

```http
GET /api/providers
```

成功返回：

```json
{
  "schemaVersion": 1,
  "revision": "sha256:...",
  "providers": []
}
```

要求：

- `providers` 按 provider、configured target key 稳定排序。
- 仅返回持久化白名单字段。
- 使用 `cache-control: no-store`。
- Demo 模式继续返回 404，不伪造 Provider 状态。
- POST 或其他 method 不提供写能力。
- store 损坏或 reopen-required 时返回固定脱敏 503，不回显文件路径、底层错误或敏感内容。

## CLI 与运行时接线

- 实际 `taskseal inspect ...` 入口使用 coordinator 记录成功或失败；connector 保持无文件系统副作用。
- `createLocalProviderObservationRuntime()` 打开并验证 observation store，恢复已有投影、为缺失的有效配置 seed `configured`，并为已配置的 GitHub/Linear 暴露 observed snapshot-import façade factory；Linear 必须先有已验证的 `snapshot_ready` scope binding。
- `startPersistentControlRoom()` 把独立 query port 传给 server。
- store 损坏时必须在 `server.listen` 前拒绝启动。
- `createLocalCodexRuntime()` 与独立 `taskseal run` 不打开 observation store；canonical event journal 损坏与 observation store 损坏互不冒充，observation 故障不能 fence Workflow service。

## 验收测试

### Application

- 五种状态均能精确投影。
- 成功 snapshot 只生成 digest/revision/missing-evidence 摘要。
- 失败只保存安全 code，不包含 message、stack、cause、token、title、URL、raw body 或 actor。
- 两个反序完成的请求以 `startedAt` 保持较新结果。
- 相同 freshness 的幂等与冲突行为确定。
- 等价时区表达在 UTC 规范化后幂等；非 RFC3339 文本和可执行数组 prototype 被拒绝。
- 配置 repository 与返回 scope 不一致时只记录脱敏 `scope_mismatch`，不保留 snapshot digest/revision。
- observation sink 失败不改变 inspection、preview 或 apply 的返回/错误。
- observed façade 通过真实 preview、真实 service commit、幂等 retry 与真实拒绝验证。
- 跨 Provider snapshot 在读取 policy 前拒绝；跨 Provider plan 与 Linear foreign Team scope 在 service 前拒绝且 canonical batch 写入为 0。

### Storage

- 记录、替换、稳定排序、重启恢复。
- missing file 返回空 projection。
- malformed JSON、额外字段、重复 identity、非法 digest、超记录数和超字节失败关闭。
- rename 前失败保持旧文件且 temporary 残留至多一份；rename 后未知结果要求 reopen。
- 同一实例并发 record 串行，不丢失不同 configured target。
- state directory symlink/Junction 不得把读写重定向出 workspace。
- 文件在 `stat` 后扩容时读取仍以 256 KiB + 1 为硬上限。

### HTTP/CLI

- `GET /api/providers` 返回完整五态安全投影和 `no-store`。
- Demo/错误 method 不暴露 API 写入口。
- HTTP 错误不回显底层 message、路径或 secret。
- Control Room 启动后能在下一次 GET 看到已原子替换的新 snapshot。
- observation store 损坏时不调用 `server.listen`。
- 实际 inspect CLI 成功与失败各记录一次，输出合同保持兼容。

### 回归

- `npm run typecheck`
- `npm test`
- 生产依赖仍为 0。
- Workflow、ImportPolicy、ImportPlan、ImportReceipt、canonical journal 与现有 dashboard 行为保持兼容。

## 完成定义

1. 五态 observation 能由真实 application 入口生成、持久化、重启恢复并通过只读 API 获取。
2. stale 请求不能覆盖较新状态。
3. 持久化与 HTTP 响应只包含白名单摘要。
4. observation 故障不会改变 Provider read 或 snapshot import 的业务结果。
5. 损坏文件不会被静默忽略或自动清空。
6. 全量测试、独立后端审查与安全/diff review 均通过。
