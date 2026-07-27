# 规格 0013：Provider Operation 安全投影

## 目标

把 Provider Operation Journal 的审批、提交、未知结果和对账状态安全投影到 Control Room，使本地操作者能同时看到：

1. Provider Observation 的配置、读取与 snapshot 五态；
2. 每个受控写 operation 的 approval、submission 和 reconciliation 状态；
3. 读取失败、响应乱序或 source version 回退时保留的 last-known 完整视图。

本规格对应 GitHub Issue `#29`，并收口 Issue `#24` 的审批占位。该切片保持完全只读，不增加浏览器审批、submit/reconcile route、真实 Linear mutation、credential 或外部 Provider 请求。

## 所有权

```text
ProviderObservationQueryPort ─┐
                              ├─ ProviderSyncProjectionQuery
ProviderOperationJournalQueryPort ─┘
                                      ↓
                               GET /api/providers
                                      ↓
                              strict browser parser
```

- Observation 与 Operation 是两个独立权威来源，不互相写入。
- application façade 只调用 `observations.list()` 与 `operations.listLatest()`；不读取 storage envelope，不依赖 coordinator。
- server 只依赖组合 query port，不拥有字段裁剪、状态映射或 revision 规则。
- persistent composition 只打开 Operation Journal query；不打开 coordinator、不执行 recovery、不注入 transport。
- demo mode 不打开或请求 Provider API。

## API v2

`GET /api/providers` 返回：

```text
schemaVersion: 2
revision: sha256:<combined content digest>
observationRevision: sha256:<Provider Observation v1 digest>
operationRevision: sha256:<safe latest operation digest>
providers: ProviderObservation v1[]
operations: ProviderOperationProjection v1[]
```

顶层 exact-key。`providers` 中的 Observation record 保持 v1 字段和语义不变；浏览器迁移期仍接受原 v1 `{ schemaVersion, revision, providers }`，并将其解释为“Operation Journal 尚未连接”。

`revision` 只绑定本次读取到的两个 component revision：

```text
digest({
  domain: "taskseal.provider-sync-projection:v2",
  schemaVersion: 2,
  observationRevision,
  operationRevision
})
```

三个 revision 都是内容指纹，不是可排序的全局版本。

## Operation 安全摘要

```text
schemaVersion: 1
provider: "linear"
operationKey: sha256:<64 lowercase hex>
configuredTarget:
  kind: "team"
  key: "linear:team-ref:<workspace>/<team>"
version: positive safe integer
status:
  approval_required
  approved
  rejected
  submitting
  created
  outcome_unknown
  reconciling
  reconciliation_absent
  reconciled
  sync_failed
approval:
  null
  or:
    decision: approved | rejected
    decidedAt: canonical RFC3339
diagnosticCode:
  null
  or one controlled-write safe code
createdAt: canonical RFC3339
updatedAt: canonical RFC3339
```

Journal 的 terminal `failed` 只表示已知未派发，在读投影中映射为 `sync_failed`。其他状态保持原语义；`approval_required` 就是可展示的 prepared 状态，不另造第二个枚举。

以下字段不得进入 projection、HTTP、浏览器 model 或日志：

- title、description、payload、payload digest；
- client request UUID、resolved Organization/Team UUID；
- plan digest、actor ID；
- Provider Issue UUID/identifier/URL；
- raw Provider body、headers、credential；
- 异常正文、stack、cause 或文件路径。

审批摘要只保留 decision 与 decidedAt。actor 可在未来 RBAC/显示名合同明确后以新增 schema 接入；本切片不把本地 actor ID 视为公开 UI 字段。

## Canonical projection

1. `listLatest()` 的每条值必须再次通过完整 Operation parser。
2. 最多 512 个 latest operation。
3. operation key 不得重复。
4. 只白名单复制安全字段，审批对象重新构造。
5. canonical 顺序为 provider、configured target kind、target key、operation key。
6. `operationRevision = digest(canonical operations)`。
7. malformed、extra/accessor/symbol、重复 key 或非法状态均整次失败关闭；不能返回部分 projection。

## 双来源 freshness

两个来源只按公开 target 坐标关联：

```text
provider + configuredTarget.key
```

它们各自保留单调依据：

| 来源 | Identity | Freshness |
| --- | --- | --- |
| Observation | provider + configuredTarget.key | startedAt |
| Operation | operationKey | version |

禁止：

- 比较 Observation `startedAt` 与 Operation `updatedAt`；
- 通过最大 timestamp 推导一个“Provider 总状态”；
- 把 operation 状态覆盖到 Observation 五态；
- 声称两个文件构成 point-in-time transaction。

façade 可以并行读取两个 query port。本次响应只代表“请求期间观察到的两个独立 snapshot”；下一次轮询自然收敛。

## 浏览器 anti-regression

HTTP request sequence 继续拒绝较旧请求晚返回。除此之外，success reducer 对 last-known model 执行 source-local 检查：

### Observation

- 已见 identity 不得消失；
- incoming `startedAt` 不得更早；
- 相同 startedAt 必须 observationId 相同。

### Operation

- 已见 operation key 不得消失；
- incoming version 不得更小；
- 相同 version 的安全摘要必须完全相同；
- 新 operation key 与更高 version 可以接受。

已经接受 v2 且看见 Operation Journal 后，v2→v1 视为回退。

回退响应按 refresh failure 处理：

- 首次无 model：error；
- 已有 model：stale，保留完整 last-known；
- 不部分接受 Observation 或 Operation；
- combined revision 相同不重建 DOM，保留 details、focus 和滚动上下文。

当前 store 不淘汰 Observation 或 Operation。拥有本地写权限者若在进程重启前删除一个完整合法 journal suffix，现有无 hash-chain 边界仍可能无法检测；#29 不扩大该保证。

## UI

Observation badge 保持五态。每张 Provider 卡增加独立 `Controlled write` fact，按匹配 target 的未解决优先级展示一个摘要；所有 latest operation 仍逐 operation 出现在 `Latest controlled writes` 列表，没有 Observation 的 operation 也必须保留。

| Operation status | 文本 | tone |
| --- | --- | --- |
| approval_required | Approval required | warning |
| approved | Approved | neutral |
| rejected | Rejected | neutral |
| submitting | Submitting | active |
| created | Created | ready |
| outcome_unknown | Outcome unknown | danger |
| reconciling | Reconciling | active |
| reconciliation_absent | Not found; decision required | warning |
| reconciled | Reconciled / creation confirmed | ready |
| sync_failed | Sync failed | danger |

匹配同一 target 的多个 operation 不按时间简单折叠：卡片 rollup 先显示 `outcome_unknown`、`reconciliation_absent`、`approval_required`、`sync_failed` 等需处理状态，再显示 active/terminal 状态。完整列表按 `updatedAt desc → operationKey` 排序。

唯一 aria-live 摘要增加：

- operation 总数；
- approval required 数；
- outcome unknown / reconciliation absent 数；
- sync failed 数；
- stale last-known 前缀。

状态必须同时有文本与形状，不能只依赖颜色。长 target 与 operation key 可换行；没有任何写按钮或写请求。

## 故障

- application projection 的 malformed source 使用固定 `PROVIDER_SYNC_PROJECTION_INVALID`。
- Observation、Operation Journal 或组合 projection 任一读取失败，整个 API 返回固定脱敏 503；不返回 partial 200。
- server 不缓存并伪装 stale 200；last-known 只由浏览器显式保留。
- startup 打开任一 file-backed query 失败时不监听端口。
- 已启动后 query corrupt/read/reopen-required 统一为安全 Provider status unavailable 响应，不回显底层正文。

## 验收

1. 全部 10 个 projection 状态精确、stable、可排序，`failed → sync_failed`。
2. payload、actor、resolved UUID、client UUID、Issue identity、plan digest 和错误正文递归扫描均不存在。
3. 空 journal、同 target 多 operation、operation-only target 与 submitting/reconciling transient 都能只读展示。
4. file-backed reopen 保持 component revisions，且 query-only 打开不调用 coordinator/transport。
5. Observation freshness 与 Operation version 分别防回退；较旧 HTTP response 仍被 request gate 丢弃。
6. v1 浏览器兼容、v2 exact parser、unknown/extra/duplicate/unsafe projection 全部失败关闭。
7. API v2、no-store、POST 404；任一 source 失败固定 503 且不泄露 sentinel。
8. Approval required、submitting、outcome unknown、reconciled 与 sync failed 均有可见和无障碍文本。
9. Demo 不请求 API；仓库中不存在新的浏览器写 route、真实 mutation、global fetch 或 credential wiring。
10. 类型检查、全量测试、浏览器走查、生产依赖和独立后端/前端审查通过。
