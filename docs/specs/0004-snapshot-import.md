# 规格 0004：Snapshot Import

## 状态

- 对应 GitHub Issue：`#3`、`#4`、`#5`
- `#3` 契约、`#4` preview 与 `#5` atomic apply 均已实现并验证。
- 独立审查：`docs/reviews/0001-snapshot-import-contract.md`、`docs/reviews/0002-atomic-snapshot-apply.md`
- 适用范围：本地单进程 TaskSeal 技术验证。
- 首个 apply 切片只开放 application API；CLI/HTTP 写入口仍未开放，没有可信 ImportPolicy provider 时默认拒绝提交。

## 背景

Provider inspection 已能把真实 GitHub 与 Linear 事实裁剪为 canonical snapshot，但当前 snapshot 只能显示或在内存中重放：

- `work_item.created` 的 event ID 不包含 provider revision。相同 Issue 修改标题后会形成“同 ID、不同内容”冲突。
- 改用新的 event ID 再次创建同一 WorkItem 又会触发 `WORK_ITEM_ALREADY_EXISTS`。
- WorkItem 只能在创建时保存一个 ExternalLink，无法同时关联 Linear Issue 与 GitHub Issue。
- journal 只支持逐事件追加。直接循环 append 多事件 snapshot 时，中途失败会留下已提交前缀。

本规格把“读取外部事实”“形成导入计划”“提交领域事件”和“写回外部系统”分成独立能力。Snapshot import 只修改 TaskSeal 本地 journal，不写 GitHub、Linear 或其他 provider。

## 目标

- 把可导入的 ProviderSnapshot 转换为确定性、可审查的 ImportPlan。
- 支持首次导入、精确重复、provider 编辑、乱序事实和一个 WorkItem 的多个 ExternalLink。
- 明确 provider 字段对 canonical WorkItem 字段的管理权，避免多来源最后写入者获胜。
- apply 前绑定 snapshot、mapping、授权策略、计划内容与当前 Workflow。
- 将计划中的 canonical events 和 ImportReceipt 原子提交。
- 保持旧 journal 可重放，并始终保留 preview-only 回退路径。

## 非目标

- 创建、更新、关闭、评论或合并任何 provider 对象。
- 自动发现两个 Issue 是否代表同一 WorkItem。
- 用标题、URL、时间或相似度推断 WorkItem、Attempt、Artifact 或 criterion 映射。
- Provider Webhook、轮询、后台调度、多进程写入、分布式事务或远程数据库。
- 通过 WorkItem/ExternalLink 元数据更新绕过 Attempt、Artifact、Evidence 或 AcceptanceDecision 的既有领域约束。
- 在首版提供强制覆盖、冲突忽略、ExternalLink 管理权迁移或成功导入的事件删除。

## 领域模型

### ProviderObjectKey

`ProviderObjectKey` 是外部对象的稳定身份。Connector 按 provider 规则构造，importer 重新校验：

```text
github:issue:<github-database-id>
linear:issue:<linear-uuid>
```

- GitHub 使用不可变 database ID，不使用 Issue number、仓库名称或 URL 作为对象身份。
- Linear 使用规范化为小写的 Issue UUID，不使用 identifier、workspace/team 名称或 URL 作为对象身份；source object、candidate event ID 和 legacy ExternalLink externalId 必须使用同一规范形式。
- 如果后续 provider 的对象 ID 只在某个 scope 内唯一，key 必须同时包含该 provider 的不可变 scope ID。

`scopeRef` 与对象身份分开，用于授权边界和诊断。GitHub 首版使用显式配置的 repository coordinate；Linear 使用 Organization/Team UUID，并保留名称作为显示字段。

### SourceRevision

每个可导入的 provider fact 必须携带：

```json
{
  "id": "provider-stable-revision",
  "occurredAt": "2026-07-26T12:00:00.000Z",
  "contentDigest": "sha256:<lowercase-hex>"
}
```

- `id` 对同一次 provider 版本稳定。GitHub Issue 首版使用 `updated_at`，Linear Issue 首版使用 `updatedAt`。
- `occurredAt` 必须是 provider 给出的更新时间，不能用本机抓取时间代替。
- `contentDigest` 只对该 provider fact 的规范化 `sourceObject` 与对象类型专属 `observed` 字段计算；不包含 Token、raw payload、抓取时间、mapping、candidate event、revision ID/时间或显示文案。
- 同 revision ID、同 digest 是重复；同 revision ID、不同 digest 是 provider 内容冲突。
- 较早 `occurredAt` 是 stale fact；相同时间但不同 revision ID 是顺序不明确。
- 缺少可复核 revision 的 v1 snapshot 不能 apply。

### ExternalLink 与字段管理权

ExternalLink 在现有 `provider`、`externalId`、`url` 基础上增加：

```json
{
  "providerObjectKey": "github:issue:123456",
  "provider": "github",
  "objectType": "issue",
  "externalId": "123456",
  "scopeRef": {
    "kind": "repository",
    "key": "github:repository:netpilot-z/taskseal"
  },
  "url": "https://github.com/netpilot-z/TaskSeal/issues/1",
  "managedFields": ["title"],
  "lastObservation": {
    "revisionId": "2026-07-26T12:00:00.000Z",
    "occurredAt": "2026-07-26T12:00:00.000Z",
    "contentDigest": "sha256:<lowercase-hex>",
    "title": "Example issue"
  }
}
```

首版规则：

1. 一个 ProviderObjectKey 在整个 Workflow 中最多出现一次。
2. 一个 WorkItem 可以有任意多个不同 ProviderObjectKey 的 ExternalLink。
3. 每个 work-item fact 的显式 import mapping 必须声明 `managedFields`；缺失时 snapshot 不可导入。
4. 新建或关联 ExternalLink 都不会因导入顺序自动获得字段管理权。
5. 同一 canonical 字段最多由一个 ExternalLink 管理。
6. 首版只有 `title` 可由 provider 管理；`requiredEvidence` 始终来自显式 TaskSeal mapping。
7. reference link 的标题仍保存在 `lastObservation.title`，但不能覆盖 WorkItem.title。
8. `status`、Attempt、Artifact、Evidence 和 AcceptanceDecision 不受 Issue 等 WorkItem fact 的字段管理权影响；PR/Check fact 仍可通过现有 `artifact.linked`、`evidence.recorded` 事件进入 Workflow。

新建 WorkItem 时 provider 标题可作为初始 title，即使该 link 的 `managedFields` 为空；这只建立初始值，不授予后续更新权。如果需要 provider 持续管理 title，mapping 必须显式声明 `["title"]`。

如果导入已有 WorkItem，mapping 中的 `requiredEvidence` 必须与当前集合相等；不相等属于阻塞冲突，不能把 provider import 当作验收规则更新接口。若 mapping 声明的字段已有另一个 link 管理，preview 返回 `FIELD_AUTHORITY_CONFLICT`。

`requiredEvidence` 在去重后按集合比较。已有 link 的 `managedFields` 也必须与 mapping 完全相等；import 不能通过一次新 snapshot 隐式授予或撤销字段管理权，变更管理权需要未来独立事件和审批规格。

## ProviderSnapshot v2

只有 schema version 2 的 snapshot 可进入 import。它继续是 read-only 产物：

```json
{
  "schemaVersion": 2,
  "mode": "read-only",
  "provider": "github",
  "scope": {
    "kind": "repository",
    "key": "github:repository:netpilot-z/taskseal"
  },
  "mapping": {
    "workItemId": "TS-1",
    "requiredEvidence": ["tests"],
    "managedFields": ["title"]
  },
  "capturedAt": "2026-07-26T12:00:01.000Z",
  "facts": [
    {
      "sourceObject": {
        "providerObjectKey": "github:issue:123456",
        "provider": "github",
        "objectType": "issue",
        "externalId": "123456",
        "url": "https://github.com/netpilot-z/TaskSeal/issues/1"
      },
      "revision": {
        "id": "2026-07-26T12:00:00.000Z",
        "occurredAt": "2026-07-26T12:00:00.000Z",
        "contentDigest": "sha256:<lowercase-hex>"
      },
      "observed": {
        "title": "Example issue",
        "createdAt": "2026-07-26T10:00:00.000Z"
      },
      "candidateEvent": {
        "eventId": "github:issue-123456:created",
        "workItemId": "TS-1",
        "type": "work_item.created",
        "occurredAt": "2026-07-26T10:00:00.000Z",
        "payload": {
          "title": "Example issue",
          "requiredEvidence": ["tests"],
          "externalLink": {
            "provider": "github",
            "externalId": "123456",
            "url": "https://github.com/netpilot-z/TaskSeal/issues/1"
          }
        }
      }
    }
  ]
}
```

完整 GitHub snapshot 可包含 Issue、Pull Request 和 Check facts。每个 candidate event 必须明确绑定一个 source object；importer 不从数组位置猜测来源。首版 import candidate allowlist 是 `work_item.created`、`artifact.linked` 和 `evidence.recorded`；Attempt 和 Acceptance 继续由各自的专用入口产生。

对象类型专属 `observed` 结构固定为：

- Issue：`title`、`createdAt`；
- Pull Request：`headRevision`；
- Check：`headRevision`、`outcome`。

完整 GitHub 交付 snapshot 的 mapping 除 `workItemId`、`requiredEvidence`、`managedFields` 外，还必须显式包含 `attemptId`、`artifactId`、`artifactRevision` 和 `criterionKey`。Pull Request 与 Check candidate 必须同时匹配这些 mapping 字段和各自的 `observed.headRevision`；Check 不能把证据绑定到同一 WorkItem 下的其他 Artifact 或 revision。

Candidate envelope 也属于不可信输入，必须从已验证 provider identity 重算并逐项匹配：Issue、Pull Request 与 Check 的 candidate event ID 使用 connector 的固定格式；PR/Check 的 `occurredAt` 必须等于 `SourceRevision.occurredAt`；Check 的 `evidenceId` 必须是 `check-<externalId>`。Importer 不能接受 snapshot 自报的未来时间或替代 identity，否则旧 Evidence 可能绕过领域层的最新结果排序。

### v2 生成入口

现有 `inspect` 命令默认继续输出 v1，避免静默破坏脚本。可导入 snapshot 必须显式选择版本和 title 管理权：

```text
taskseal inspect github-issue ... \
  --snapshot-version 2 \
  --title-management provider|none

taskseal inspect github ... \
  --snapshot-version 2 \
  --title-management provider|none

taskseal inspect linear ... \
  --snapshot-version 2 \
  --title-management provider|none
```

- `provider` 生成 `managedFields: ["title"]`。
- `none` 生成 `managedFields: []`，适合把当前 provider 作为 reference link。
- v2 缺少 `--title-management` 时参数校验失败；v1 不接受该参数。
- Application inspection API 对应接收 `snapshotVersion: 2` 和显式 `managedFields`，不能根据 provider 类型、现有 WorkItem 或调用顺序设置默认值。
- `requiredEvidence` 必须非空且无重复，按 key 排序后进入 snapshot；`managedFields` 必须是无重复的已知字段集合并按固定顺序输出。

`#4` 的实现切片包含这个版本化生成入口和纯 preview；在 v2 normalizer 就绪前只能用经过 schema 校验的 fixture 验证 planner。

### Snapshot 语义摘要

`snapshotDigest` 使用 RFC 8785 等价的稳定 JSON 序列化和 SHA-256，对以下语义字段计算：

- schemaVersion、provider、规范化 scope；
- 显式 mapping；
- 每个 fact 的 ProviderObjectKey、SourceRevision、observed 字段和 candidate event。

`capturedAt`、本地路径、抓取耗时、日志文本和 UI 文案不进入 digest。相同外部事实的再次读取因此具有相同语义摘要。

`SourceRevision.contentDigest` 与 `snapshotDigest` 有意分层：前者只证明 provider 对象内容，mapping 或 candidate envelope 改动不会伪造一个新的 provider revision；后者绑定本次可导入 snapshot 的完整语义，包括 mapping 与 candidate event。

Importer 必须限制 snapshot 大小、facts 数量、字符串长度和已知事件类型；任何错误都不得回显 raw provider payload、凭证、请求头或未经裁剪的响应正文。

### 输入上限

首版在稳定序列化和 digest 前执行以下限制：

| 项目 | 上限 |
| --- | --- |
| UTF-8 snapshot 原文 | 1 MiB，在 JSON parse 前检查 |
| JSON 嵌套深度 | 16 |
| facts / candidate events | 各 100 |
| 任意对象字段数 | 64 |
| 通用字符串 | 4,096 个 Unicode code points |
| title | 512 个 Unicode code points |
| URL | 2,048 个 Unicode code points |
| provider/object/scope/revision/event ID | 各 256 个 Unicode code points |
| requiredEvidence | 64 个唯一 key，每个 128 个 code points |
| managedFields | 8 个唯一值；首版 allowlist 只有 `title` |

Snapshot 超限统一返回 `SNAPSHOT_LIMIT_EXCEEDED`，错误消息只包含字段名和限制，不回显输入值。ImportPlan 在 apply 时也按 2 MiB、256 actions、256 events 和深度 16 重新限制并校验；超限返回 `IMPORT_PLAN_LIMIT_EXCEEDED`，防止加载被篡改的计划。

### URL 与 scope

ExternalLink URL 是不可信输入，必须与 provider object 和允许 scope 同时校验：

- GitHub Issue URL 必须是无 userinfo、非自定义端口、无 query/fragment 的 `https://github.com/<owner>/<repository>/issues/<number>`，owner/repository 与允许 repository coordinate 按 GitHub 规则规范化比较。
- Linear Issue URL 必须是无 userinfo、非自定义端口、无 query/fragment 的 `https://linear.app/.../issue/...`；Organization/Team UUID 仍由独立 scopeRef 校验，不能从 URL path 反推授权。
- sourceObject 的 provider、objectType、externalId、scopeRef 和 URL 必须来自同一个已校验 fact。
- Artifact/Evidence 的第三方跳转若未来允许，必须使用不同字段并在 UI 标为外部不可信链接，不能复用 ExternalLink 校验结果。

## Canonical events

Import 不直接 upsert Workflow。它复用现有事件，并新增以下事件。

对于首次创建，importer 会根据 ProviderObjectKey、SourceRevision 和显式 mapping 重新生成带扩展 ExternalLink 的 `work_item.created`；不能把 snapshot 中的 candidate event 原样 append。Candidate event 是经过裁剪的 provider 事实候选，不是写入授权。

重新生成的 `work_item.created` 保持现有 envelope 和 payload 字段：title 来自已校验 fact，requiredEvidence 来自规范化 mapping，externalLink 使用本规格的完整结构；event ID 按后述 import action identity 生成。它不能携带 status、Attempt、Artifact、Evidence 或 AcceptanceDecision。

### external_link.linked

给已有 WorkItem 添加一个此前未出现的 provider object：

```json
{
  "eventId": "taskseal:import:v1:link:<sha256-action-identity>",
  "workItemId": "TS-1",
  "type": "external_link.linked",
  "occurredAt": "2026-07-26T12:00:00.000Z",
  "payload": {
    "link": {
      "providerObjectKey": "github:issue:123456",
      "provider": "github",
      "objectType": "issue",
      "externalId": "123456",
      "scopeRef": {
        "kind": "repository",
        "key": "github:repository:netpilot-z/taskseal"
      },
      "url": "https://github.com/netpilot-z/TaskSeal/issues/1",
      "managedFields": [],
      "lastObservation": {
        "revisionId": "2026-07-26T12:00:00.000Z",
        "occurredAt": "2026-07-26T12:00:00.000Z",
        "contentDigest": "sha256:<lowercase-hex>",
        "title": "Example issue"
      }
    }
  }
}
```

领域层必须拒绝重复 ProviderObjectKey、重复 WorkItem link 和第二个 `title` 管理者。

### external_link.observed

记录已关联 provider object 的较新版本：

```json
{
  "eventId": "taskseal:import:v1:observe:<sha256-action-identity>",
  "workItemId": "TS-1",
  "type": "external_link.observed",
  "occurredAt": "2026-07-26T12:30:00.000Z",
  "payload": {
    "providerObjectKey": "github:issue:123456",
    "expectedRevisionId": "2026-07-26T12:00:00.000Z",
    "observation": {
      "revisionId": "2026-07-26T12:30:00.000Z",
      "occurredAt": "2026-07-26T12:30:00.000Z",
      "contentDigest": "sha256:<lowercase-hex>",
      "url": "https://github.com/netpilot-z/TaskSeal/issues/1",
      "title": "Renamed issue"
    }
  }
}
```

该事件更新 ExternalLink 的 URL 和 lastObservation，不自行更新 canonical WorkItem 字段。

`expectedRevisionId` 通常必须等于当前 lastObservation.revisionId。唯一允许 `null` 的情况是兼容旧 journal：link 确实来自缺少 revision 的 legacy `work_item.created`，且当前 lastObservation 仍为空。Baseline event 的 `payload.baseline` 额外携带：

```json
{
  "baseline": {
    "providerObjectKey": "github:issue:123456",
    "objectType": "issue",
    "scopeRef": {
      "kind": "repository",
      "key": "github:repository:netpilot-z/taskseal"
    },
    "managedFields": ["title"]
  }
}
```

Domain 要求 legacy link 的 provider/externalId 与 v2 object 完全一致、scope 已通过当前 ImportPolicy、managedFields 来自本次显式 mapping，且目标字段没有其他管理者。Baseline 会补齐 objectType、scopeRef、managedFields 和 lastObservation；完成后所有 observation 都使用非空 expectedRevisionId。若管理 title 的 legacy link 在 baseline 时标题不同，可在同一 batch 中按 before/after 规则追加 `work_item.updated`。

### work_item.updated

只有管理目标字段的 ExternalLink 才能产生 provider 驱动的 WorkItem 更新。首版只允许 title：

```json
{
  "eventId": "taskseal:import:v1:update-title:<sha256-action-identity>",
  "workItemId": "TS-1",
  "type": "work_item.updated",
  "occurredAt": "2026-07-26T12:30:00.000Z",
  "payload": {
    "source": {
      "providerObjectKey": "github:issue:123456",
      "revisionId": "2026-07-26T12:30:00.000Z",
      "contentDigest": "sha256:<lowercase-hex>"
    },
    "changes": {
      "title": {
        "before": "Example issue",
        "after": "Renamed issue"
      }
    }
  }
}
```

领域层必须校验：

- source link 属于该 WorkItem；
- source link 的 lastObservation 与 source 完全一致；
- source link 的 managedFields 包含 title；
- 当前 title 等于 `before`；
- `after` 是非空、满足长度限制的字符串；
- payload 不包含 status、requiredEvidence、Attempt、Artifact、Evidence 或 AcceptanceDecision。

一次由 title 管理者驱动的 provider 更新，固定事件顺序是 `external_link.observed` 后 `work_item.updated`，二者在同一个 ImportBatchRecord 中提交。

### Event ID

Importer 用稳定 JSON 和 SHA-256 从以下 action identity 生成 event ID：

```text
event type + workItemId + providerObjectKey + source revision ID + semantic target
```

event ID 不包含 preview/apply 时间、actor、数组位置或本地路径。同一 source revision 的不同规范化内容仍产生相同 event ID，从而被识别为 `SOURCE_REVISION_CONTENT_CONFLICT`，不能伪装成新事件。

preview、apply 校验与 journal replay 必须调用同一个 event identity 契约重新生成 ID，不能从 ID 字符串前缀反推事件类型，也不能各自维护摘要算法。

## Preview 契约

应用层公共接口：

```text
previewSnapshotImport({ snapshot, workflow, importPolicy }) -> ImportPlan
```

它是纯函数：

- 不读取或写入 journal；
- 不调用 provider；
- 不读取环境凭证；
- 不使用当前时间或随机数；
- 不修改传入的 snapshot 或 workflow。

处理顺序：

1. 校验 v2 schema、大小、安全字段和 SourceRevision。
2. 校验 provider scope 与当前 ImportPolicy。
3. 校验 mapping，并建立全部 WorkItem 的 ProviderObjectKey 索引。
4. 计算 snapshotDigest、mappingDigest、policyDigest 和 baseWorkflowDigest。
5. 将 facts 转换为 create、link、refresh、update、skip 或 conflict actions。
6. 按领域依赖和稳定 event ID 排序，在 workflow 副本上模拟全部拟追加事件。
7. 把领域错误转换为稳定 conflict code；任何 conflict 都使计划不可 apply。
8. 对计划语义字段计算 planDigest。

preview、apply 校验与 journal replay 共享同一个 plan digest material 构造函数。`mode`、`planDigest` 自身、`summary` 和人类可读文案不进入摘要；events、actions、PolicyBinding 和冲突/警告投影的任何语义改动都必须改变 planDigest。

`baseWorkflowDigest` 对完整 canonical Workflow 稳定序列化后计算，包含 processed event ID/digest 和所有 WorkItem 状态，但排除进程内 queue、UI 派生数据和 ImportReceipt。任意 canonical event 提交都会改变它；同一 journal 重启重放必须得到相同值。

首版使用固定依赖顺序：`work_item.created` → `external_link.linked` → `external_link.observed` → `work_item.updated` → `artifact.linked` → `evidence.recorded`。同一类型按 `occurredAt`、event ID 排序。Snapshot 中出现 allowlist 以外的 candidate type 直接返回 `SNAPSHOT_INVALID`，不能由数组顺序决定执行权限。

### ImportPolicy v1

ImportPolicy 是不含凭证的授权输入，唯一合法结构为：

```json
{
  "schemaVersion": 1,
  "capabilities": {
    "snapshot.import.apply": true
  },
  "allowedScopes": [
    {
      "provider": "github",
      "scopeRef": {
        "kind": "repository",
        "key": "github:repository:netpilot-z/taskseal"
      },
      "objectTypes": ["check", "issue", "pull_request"]
    },
    {
      "provider": "linear",
      "scopeRef": {
        "kind": "team",
        "key": "linear:team:<team-uuid>",
        "parentKey": "linear:organization:<organization-uuid>"
      },
      "objectTypes": ["issue"]
    }
  ]
}
```

规范化规则：

- schemaVersion 必须为 1；所有层级的未知字段、未知 capability、provider、scope kind 或 object type 都拒绝。
- capabilities 必须恰好包含布尔值 `snapshot.import.apply`。
- allowedScopes 最多 32 条，按 provider、scopeRef.key 排序；重复 scope 拒绝。
- GitHub repository key 的 owner/repository 转小写；Linear UUID 转小写并验证格式。
- objectTypes 是非空、无重复、排序后的 allowlist；snapshot 全部 fact 类型必须被同一 scope record 覆盖。
- 名称、URL、Token、Cookie 和凭证不进入 policy。

Preview 从规范化 policy 和当前 snapshot 派生唯一的 `PolicyBinding`：

```json
{
  "schemaVersion": 1,
  "capability": "snapshot.import.apply",
  "applyAllowed": true,
  "provider": "github",
  "scopeRef": {
    "kind": "repository",
    "key": "github:repository:netpilot-z/taskseal"
  },
  "requiredObjectTypes": ["check", "issue", "pull_request"]
}
```

`policyDigest` 只对这个与目标相关的 PolicyBinding 稳定序列化后计算，并把完整 binding 放入 ImportPlan。这样无关 scope 的配置变化不会使计划 stale，但 capability、目标 scope 或所需对象类型变化一定会改变 digest。

Preview 在 capability 关闭时仍可生成 `applyAllowed: false` 的计划；启用 capability 后必须重新 preview。Preview 和 apply 必须复用同一个 policy normalizer/binding builder，不能分别实现排序或默认值。

### ImportPlan

```json
{
  "schemaVersion": 1,
  "mode": "preview",
  "snapshotDigest": "sha256:<lowercase-hex>",
  "mappingDigest": "sha256:<lowercase-hex>",
  "policyBinding": {
    "schemaVersion": 1,
    "capability": "snapshot.import.apply",
    "applyAllowed": true,
    "provider": "github",
    "scopeRef": {
      "kind": "repository",
      "key": "github:repository:netpilot-z/taskseal"
    },
    "requiredObjectTypes": ["check", "issue", "pull_request"]
  },
  "policyDigest": "sha256:<lowercase-hex>",
  "baseWorkflowDigest": "sha256:<lowercase-hex>",
  "planDigest": "sha256:<lowercase-hex>",
  "summary": {
    "create": 1,
    "link": 0,
    "refresh": 0,
    "update": 0,
    "skip": 0,
    "conflict": 0
  },
  "actions": [],
  "events": [],
  "conflicts": [],
  "warnings": []
}
```

计划不包含生成时间。actions、events、conflicts 和 warnings 使用固定排序；人类可读文案不进入 planDigest。digest material 包含 schemaVersion、snapshot/mapping/policy/base 四个 digest、完整 PolicyBinding、稳定 action codes、planned canonical events、conflict codes 和 warning codes。

每个 ImportAction 使用固定 schema：

```json
{
  "actionId": "sha256:<lowercase-hex>",
  "kind": "create",
  "workItemId": "TS-1",
  "sourceObjectKey": "github:issue:123456",
  "sourceRevisionId": "2026-07-26T12:00:00.000Z",
  "semanticTarget": "work-item",
  "reasonCode": "NEW_WORK_ITEM",
  "eventIds": ["taskseal:import:v1:create:<sha256-action-identity>"]
}
```

`kind` 只允许 `create|link|refresh|update|skip|conflict`。actionId 由其稳定身份字段生成；reasonCode、eventIds 和对应完整 events 一起进入 planDigest。Conflict 还在 `conflicts` 中提供 `{actionId, code, domainCode?}` 的机器可读投影，warning 同理；显示消息不进入 digest。summary 完全从 actions 派生，不能成为第二份事实。

### 决策表

| 场景 | Preview 结果 | Apply |
| --- | --- | --- |
| WorkItem 不存在，mapping 与 fact 有效 | `create`，按显式 managedFields 建立 link | 原子追加 `work_item.created` |
| 相同 ProviderObjectKey、revision 和 digest 已存在 | `skip / EXACT_DUPLICATE` | 只生成或返回幂等回执，不追加领域事件 |
| Candidate event ID 已处理且完整 event digest 相同 | `skip / EXACT_EVENT_DUPLICATE` | 不重复追加领域事件 |
| Candidate event ID 已处理但完整 event digest 不同 | `conflict / EVENT_ID_CONFLICT` | 拒绝 |
| 相同对象出现较新 revision，link 管理 title，标题改变 | `refresh` + `update` | 原子追加 observed 与 updated |
| 相同对象出现较新 revision，reference link 标题改变 | `refresh` | 只更新 ExternalLink observation |
| 相同 revision ID、不同 content digest | `conflict / SOURCE_REVISION_CONTENT_CONFLICT` | 拒绝 |
| revision occurredAt 早于 lastObservation | `skip / STALE_SOURCE_REVISION` warning | 不追加该 fact |
| 相同 occurredAt、不同 revision ID | `conflict / SOURCE_REVISION_ORDER_AMBIGUOUS` | 拒绝 |
| ProviderObjectKey 已关联另一个 WorkItem | `conflict / PROVIDER_OBJECT_ALREADY_LINKED` | 拒绝 |
| 已有 WorkItem 的 requiredEvidence 与 mapping 不同 | `conflict / WORK_ITEM_MAPPING_CONFLICT` | 拒绝 |
| 已有 link 的 managedFields 与 mapping 不同，或目标字段已有管理者 | `conflict / FIELD_AUTHORITY_CONFLICT` | 拒绝 |
| candidate event 缺少 Attempt/Artifact 等前置状态 | `conflict / DOMAIN_INVARIANT_VIOLATION`，保留领域 cause code | 拒绝 |
| apply 时 Workflow 已变化 | preview 有效，apply 返回 `IMPORT_PLAN_STALE` | 零写入，重新 preview |
| apply capability 关闭或允许 scope 已变化 | preview 历史结果不再获授权 | `IMPORT_APPLY_FORBIDDEN` 或 `IMPORT_POLICY_STALE`，零写入 |
| 相同 planDigest 已成功提交 | 可忽略当前 base digest | 返回原 ImportReceipt，不重复写 |
| journal 在提交点前失败 | 计划仍有效或需重新 preview | 原 journal 与内存均不改变 |
| 提交点后响应丢失或进程退出 | 重启可找到完整 batch | 按 planDigest 返回已有回执 |
| v1/未知 schema snapshot | `SNAPSHOT_SCHEMA_NOT_IMPORTABLE` | 零写入 |

Stale revision 是明确的非阻塞 skip，而不是“最后写入者获胜”。顺序无法证明时必须失败关闭；首版没有 force 参数。

## Apply 契约

应用层公共接口：

```text
applySnapshotImport({
  plan,
  expectedPlanDigest,
  actor
}) -> { receipt: ImportReceipt, resolution: "committed" | "idempotent" }
```

执行顺序：

1. 在 TaskSealService 的单进程 write queue 内执行。
2. 重新执行 ImportPlan 的大小/schema 校验，重算 planDigest，并与 plan.planDigest、expectedPlanDigest 比较；不一致返回 `IMPORT_PLAN_TAMPERED`。
3. 先按 planDigest 查询已提交 ImportReceipt；存在时直接返回原回执。
4. 通过 TaskSealService 的可信 `importPolicyProvider` 读取并规范化当前 ImportPolicy，为计划目标重建 PolicyBinding；policy 无效或 capability 未启用分别返回 `IMPORT_POLICY_INVALID`、`IMPORT_APPLY_FORBIDDEN`，policyDigest 与计划不同返回 `IMPORT_POLICY_STALE`。
5. 重新验证计划中每个 provider scope 仍在当前允许列表；不能只比较调用方传入的摘要。
6. 计划包含 conflict 时返回 `IMPORT_PLAN_BLOCKED`。
7. 重算当前 baseWorkflowDigest；不一致返回 `IMPORT_PLAN_STALE`。
8. 在内存副本依次 apply 全部 planned events；任一失败都不访问 journal。
9. 构造一个 ImportBatchRecord，由 journal 原子提交。
10. journal 确认提交后，一次性替换内存 Workflow 并登记 ImportReceipt。

`expectedPlanDigest` 是操作者或上层审批服务确认的值。actor 只进入回执，不进入 planDigest；至少包含稳定类型和 ID，不能包含 Token、Cookie 或凭证。

TaskSealService 持有可信 `importPolicyProvider`，并在 write queue 内获取当前值；apply 不接受调用方用任意 policy 对象覆盖它。CLI 每次命令从当前已验证配置构建 policy，常驻 server 的 provider 必须反映配置撤销或要求重启后再写。已提交 receipt 的只读找回允许在 capability 或 scope 撤销后执行，但撤销后不能产生任何新 batch。

重开 service 后可调用：

```text
getImportReceipt({ planDigest }) -> ImportReceipt | null
```

它只查询已经通过 replay 验证的 receipt，不触发 apply，也不受当前 provider write 权限影响。

如果 storage 报告 commit point 后结果未知，TaskSealService 必须立即进入 fenced 状态：除只返回 fenced 原因和 planDigest 的 health/status 外，`getWorkflow`、`getWorkItem`、dashboard snapshot、append、Runner、recover 和任何后续 import 都返回 `SERVICE_REOPEN_REQUIRED`。只有重新 open journal 并完整 replay 后才能恢复读写；不能暴露或继续使用提交前旧内存。

## ImportBatchRecord 与原子性

Import batch 是 journal 存储记录，不是绕过领域规则的新 domain event：

```json
{
  "recordType": "import.batch",
  "schemaVersion": 1,
  "batchId": "import:<plan-digest>",
  "planDigest": "sha256:<lowercase-hex>",
  "snapshotDigest": "sha256:<lowercase-hex>",
  "mappingDigest": "sha256:<lowercase-hex>",
  "policyBinding": {
    "schemaVersion": 1,
    "capability": "snapshot.import.apply",
    "applyAllowed": true,
    "provider": "github",
    "scopeRef": {
      "kind": "repository",
      "key": "github:repository:netpilot-z/taskseal"
    },
    "requiredObjectTypes": ["check", "issue", "pull_request"]
  },
  "policyDigest": "sha256:<lowercase-hex>",
  "baseWorkflowDigest": "sha256:<lowercase-hex>",
  "actions": [],
  "conflictCodes": [],
  "warningCodes": [],
  "appliedAt": "2026-07-26T12:40:00.000Z",
  "actor": {
    "type": "human",
    "id": "operator"
  },
  "outcome": "applied",
  "events": [],
  "summary": {
    "eventIds": [],
    "skippedCodes": [],
    "warningCodes": []
  }
}
```

`batchId` 由 planDigest 唯一确定。零领域事件的 no-op 计划也可提交一次回执；再次 apply 返回同一回执。

Replay 先从 batch.policyBinding 重算 policyDigest，再使用 schemaVersion、snapshotDigest、mappingDigest、policyDigest、baseWorkflowDigest、完整 binding、稳定 actions、完整 events、conflictCodes 和 warningCodes 重建与 preview 相同的 digest material，并重新计算 planDigest。成功提交的 batch 必须满足 `policyBinding.applyAllowed: true` 且 conflictCodes 为空。actor、appliedAt、outcome 和显示 summary 不进入 digest。任何缺字段、event digest 不一致、planDigest 不匹配，或同 batchId 不同内容都属于 `JOURNAL_CORRUPT`。

FileEventJournal 的 batch commit 必须满足：

- 旧 journal 与新增 batch 先写入同目录临时文件；
- 临时文件继承或收紧原 journal 权限，完整写入并 fsync 后，才以同一文件系统的原子 replace 进入可见状态；
- replace 成功是 commit point；平台支持时还要 fsync 父目录；
- commit point 前失败时原 journal 字节不变，内存不变；
- commit point 后即使响应丢失或 TaskSeal 进程退出，重新 open 也只能看到完整 batch，不能看到事件前缀；
- commit point 后结果未知时当前 service 必须 fenced，不能用提交前内存继续写；
- 遗留临时文件不参与 replay，可在下次安全启动时清理；
- 单进程 write queue 串行普通 append 与 batch commit。

首版原子性承诺覆盖受支持本地文件系统上的进程异常、强制退出和响应丢失，不承诺 OS/磁盘断电 durability。实现必须在开放 apply capability 前用同目录 replace 探针和故障注入证明目标平台满足本契约；不支持时返回 `JOURNAL_ATOMIC_COMMIT_UNSUPPORTED` 并保持 preview-only，不能退化为逐事件 append。若未来承诺断电恢复，必须另行定义目录持久化、generation/backup 恢复和平台矩阵。

如果 commit point 后无法确认响应，返回 `IMPORT_COMMIT_OUTCOME_UNKNOWN`。调用方必须按 planDigest 重开 service 并查询回执，不能生成新 operation ID 猜测重试。

Journal replay 接受两种记录：

1. 现有 bare canonical event，按 legacy record 处理；
2. `import.batch`，先校验 record schema、batchId、planDigest 和全部 events，再在 workflow 副本中完整 apply。

Batch replay 顺序固定为：

1. 校验 record schema、重算 planDigest 和完整 record digest；`summary`、eventIds 全部从 events/actions 重算，不能信任持久化显示值。
2. 如果 batchId 已出现，完整 record digest 相同则直接幂等跳过，不再比较 baseWorkflowDigest；任一字段不同都返回 `JOURNAL_CORRUPT`。
3. 只有首次出现的 batch 才要求当前 replay Workflow digest 等于 batch.baseWorkflowDigest；否则记录顺序或历史内容已变化，返回 `JOURNAL_CORRUPT`。
4. 在 Workflow 副本完整应用 events，成功后登记不可变 receipt 和已见 batchId。

任一 batch 内事件无效时 service 返回 `JOURNAL_CORRUPT`，不能暴露部分内存状态。Replay 只验证历史 policyDigest 已绑定获批计划，不用当前策略推翻已提交事实。首版不支持两个 TaskSeal 进程同时写同一 journal；多进程 lock/CAS 属于后续规格。

## ImportReceipt

ImportReceipt 是经过校验的 ImportBatchRecord 审计投影，至少提供：

- batchId、planDigest、snapshotDigest、mappingDigest、policyDigest 和 baseWorkflowDigest；
- actor、appliedAt、outcome；
- 实际提交的 event IDs；
- skip、warning 摘要；

Receipt 不保存 raw snapshot、凭证或绝对路径。成功 apply 后不修改 receipt；相同 planDigest 总是返回相同业务回执。

`resolution` 是本次 API 调用如何取得回执的瞬时响应元数据，不持久化到 receipt。重启 replay 或幂等重试不得改变 receipt 字节。

## 稳定错误与恢复

| Code | 阶段 | 是否写入 | 恢复 |
| --- | --- | --- | --- |
| `SNAPSHOT_SCHEMA_NOT_IMPORTABLE` | preview | 否 | 重新 inspect 生成 v2 snapshot |
| `SNAPSHOT_INVALID` | preview | 否 | 修复 connector 或输入 |
| `SNAPSHOT_LIMIT_EXCEEDED` | preview/apply 校验 | 否 | 缩小输入；不得提高限制后直接重试未审查内容 |
| `SNAPSHOT_SCOPE_MISMATCH` | preview | 否 | 修正显式配置或选择正确对象 |
| `WORK_ITEM_MAPPING_CONFLICT` | preview | 否 | 修正 mapping；不得覆盖 requiredEvidence |
| `FIELD_AUTHORITY_CONFLICT` | preview | 否 | 使用现有管理权；另行设计显式管理权迁移 |
| `PROVIDER_OBJECT_ALREADY_LINKED` | preview | 否 | 使用原 WorkItem 或人工决定后续补偿 |
| `SOURCE_REVISION_CONTENT_CONFLICT` | preview | 否 | 重新读取 provider 并审查 normalizer |
| `SOURCE_REVISION_ORDER_AMBIGUOUS` | preview | 否 | 获取可排序 revision；不得 force |
| `DOMAIN_INVARIANT_VIOLATION` | preview | 否 | 补齐显式映射或领域前置事实 |
| `IMPORT_PLAN_BLOCKED` | apply | 否 | 处理 conflicts 后重新 preview |
| `IMPORT_PLAN_LIMIT_EXCEEDED` | apply 校验 | 否 | 重新生成受限计划；不得应用被扩大的输入 |
| `IMPORT_PLAN_TAMPERED` | apply | 否 | 使用未修改的计划和确认 digest |
| `IMPORT_POLICY_INVALID` | preview/apply | 否 | 修正 versioned policy；不得使用默认 scope |
| `IMPORT_APPLY_FORBIDDEN` | apply | 否 | 经授权启用 capability 后重新 preview |
| `IMPORT_POLICY_STALE` | apply | 否 | 按当前 scope/capability 重新 preview |
| `IMPORT_PLAN_STALE` | apply | 否 | 基于当前 Workflow 重新 preview |
| `JOURNAL_WRITE_FAILED` | apply，commit 前 | 否 | 排除存储故障后重试同一计划 |
| `JOURNAL_ATOMIC_COMMIT_UNSUPPORTED` | apply 初始化/提交前 | 否 | 保持 preview-only 或使用经验证的 storage |
| `IMPORT_COMMIT_OUTCOME_UNKNOWN` | apply，commit 后未知 | 无部分状态 | 重开 service，按 planDigest 查询回执 |
| `SERVICE_REOPEN_REQUIRED` | commit 结果未知后的后续写入 | 否 | 重开并完整 replay journal |
| `JOURNAL_CORRUPT` | replay | 不继续 | 隔离 journal，人工恢复；不得跳过坏 batch |

## 模块所有权与依赖方向

### 运行时数据流

```text
provider read client
  → connector normalizer (ProviderSnapshot v2)
  → application snapshot importer (preview / plan)
  → domain workflow (canonical event invariants)
  → TaskSealService (stale check / single writer / receipt)
  → event journal (atomic batch record)
```

| 模块 | 所有权 |
| --- | --- |
| `src/connectors/*` | ProviderObjectKey、SourceRevision、裁剪 fact 与 candidate event；无 journal 依赖 |
| `src/application/provider-inspection.ts` | scope/mapping 组装和 ProviderSnapshot v2；无写入 |
| `src/application/snapshot-import.ts` | snapshot 校验、digest、纯 preview、ImportPlan |
| `src/application/import-policy.ts` | ImportPolicy v1 规范化、PolicyBinding 与 policyDigest |
| `src/application/import-batch.ts` | ImportBatchRecord 语义校验、planDigest 重算与 receipt 投影 |
| `src/domain/workflow.ts` | ExternalLink 唯一性、字段管理权、legacy upcast、新 canonical events 与全部领域不变量 |
| `src/application/taskseal-service.ts` | write queue、policy/plan/revision 校验、完整 replay 编排、内存候选状态、receipt 幂等 |
| `src/storage/event-journal.ts` | record 字节读写、格式边界与原子 batch commit；不解释 WorkItem 或字段权威 |
| `src/dashboard/*` | 后续只读投影 ImportPlan/Receipt；不得直接调用 provider 或 journal |

### 源码依赖

下面箭头指向被依赖模块，与上面的运行时数据流不是同一方向：

```text
CLI / HTTP
  → provider-inspection → connectors / read clients
  → TaskSealService → snapshot-import → domain
                    → import-policy
                    → import-batch
                    → journal port ← FileEventJournal
```

Domain 不依赖 application、connector、storage、CLI 或 ProviderSnapshot。Application 可以依赖 domain 和 connector ports；FileEventJournal 只实现持久化 port。Legacy upcaster 属于 domain compatibility boundary，storage 不能根据 URL、provider 或当前配置决定字段权威。

## 安全与审计

- Snapshot 是不可信输入；所有字符串、URL、数组、摘要和事件类型都必须有界并校验。
- ImportPlan 的 action kind、reason、semantic target、event type、稳定排序和 warning/conflict 投影必须同构校验，不能只信任调用方重算的 digest。
- ImportPlan/ImportBatch 在构造完整 canonical JSON 前先执行深度、宽度和字节预算；journal 在 JSON.parse 前拒绝超限记录。
- URL 只保留规范化 HTTPS 地址，不保留认证信息、query token 或 fragment。
- Provider 凭证只存在于 read client 请求边界，不进入 snapshot、plan、receipt、journal 或错误。
- Preview 不调用网络，不访问文件系统，不读取环境变量。
- Apply 只获得本地 journal 写能力；它不因此获得 provider write capability。
- planDigest 是审批绑定，不是身份认证。真正的多用户授权、RBAC 和签名属于后续阶段。

## 兼容与回退

- ProviderSnapshot v1 继续支持 display 和内存重放，但 import 必须失败关闭并要求重新 inspect。
- 4 MiB 单行上限内的旧 bare-event journal 原样可读，不做格式迁移；超过上限时失败关闭并要求离线迁移，不能在受限进程内无界加载。
- 只对带完整 v2 ExternalLink 的新 import create 强制 512-code-point title 上限；单行上限内的历史 bare `work_item.created` 保留旧版“非空”校验，避免升级后无法重放此前合法的长标题。
- Legacy upcaster 对历史 GitHub/Linear WorkItem link 确定性补充 `objectType: "issue"` 和由 provider/externalId 构造的 ProviderObjectKey，同时标记 `legacy: true`、`scopeRef: null`、`managedFields: null`、`lastObservation: null`。它不从 URL、当前配置或 WorkItem title 猜 scope/字段管理权。
- 历史 `taskseal` self-link 或未知 provider 使用 `legacy:<provider>:<externalId>` 身份并保持本地管理；不能被一个 GitHub/Linear snapshot 基线升级。
- 第一次匹配的 v2 observation 用 `expectedRevisionId: null` 和 baseline payload 补齐 scope、显式 managedFields 与 SourceRevision；非 legacy link、对象身份不匹配、重复 baseline 或字段管理权冲突均拒绝。
- 新事件类型只通过追加扩展，不改变已有事件 payload 的历史含义。
- apply 可由独立 capability/feature flag 默认关闭；preview 始终可用。
- 成功 batch 是不可变审计事实。首版没有自动 undo；纠错必须通过后续明确的补偿事件规格，不能删除 journal 行。
- 任一实现风险未通过时，系统回退到现有 provider inspection + preview-only，不影响 Runner 和现有 journal。

## 验收与验证矩阵

### Preview 纯函数

- v2 首次、精确重复、title-manager update、reference update、多 link、同一 snapshot 多 Issue 到一个 WorkItem、mapping conflict、对象跨 WorkItem 冲突。
- stale、相同时间不同 revision、同 revision 不同 digest。
- snapshot/facts 随机顺序得到相同稳定计划。
- v1 默认输出不变；v2 必须显式选择 title management，mapping 数组规范化后 digest 稳定。
- ImportPolicy scope/objectTypes 排列不同但语义相同时 binding/digest 相同；重复项、未知字段、错误 UUID/scope key 一律拒绝。
- snapshot byte/depth/fact/string/URL 上下限和 provider-specific URL/scope 绑定。
- PR/Check candidate 的 revision time、event ID、Artifact/Evidence identity 不可脱离已验证 provider fact。
- Linear connector 返回大写 UUID 时，v2 fact 在进入 preview 前统一规范化为小写且保持 source/candidate identity 一致。
- 无当前时间、随机数、网络、journal 或环境依赖。
- 输出不含 Token、raw payload、绝对路径或 URL 凭证。

### Domain

- `external_link.linked` 的全局唯一性与字段管理权唯一性。
- `external_link.observed` 的 previous revision、stale 与 ambiguous 校验。
- Legacy link 只允许一次 `expectedRevisionId: null` baseline，非 legacy link 或第二次 null 必须拒绝。
- 旧 GitHub/Linear link 可基线并在重启后保持相同身份；旧 self-link、错误 provider/externalId、scope mismatch 和 authority conflict 必须拒绝。
- 单行上限内的历史 bare create 长标题仍可重放；512-code-point 上限只约束新 rich import create 与 observation/update。
- `work_item.updated` 只能由 title 管理者修改 title，且验证 before 值。
- 新增的 ExternalLink/WorkItem update 事件不得改变 AcceptanceDecision 或解除 Attempt/Evidence 约束；既有 artifact/evidence 事件继续按原规则影响状态。
- event ID 精确重复幂等，同 ID 异内容仍失败。

### Service 与 journal

- 全部 planned events 先在内存副本通过才调用 storage。
- expectedPlanDigest、tamper、stale workflow、policy/capability 变化和 blocking conflict 均零写入。
- 已提交 receipt 可在 capability 撤销后只读找回，但撤销后不能提交新 batch。
- commit 前每个可注入失败点都保持 journal 字节和内存不变。
- commit 后响应丢失通过 planDigest 找回同一 receipt。
- commit 后结果未知会 fence 当前 service，任何后续写入必须失败关闭。
- fenced 状态通过 persistent `/health` 返回 `503`、原因和 planDigest；dashboard 与其他 service 读取继续失败关闭。
- 初次、重复、no-op、多事件 batch 在重启后得到相同 workflow/receipt。
- 含事件的完全相同重复 batch，无论相邻或出现在后续 bare event 之后都只应用一次；相同 batchId 任一字段不同都判损坏。
- legacy event 与 import batch 混合重放。
- 重放时先处理 seen batch 幂等；只有首次出现的 batch 在应用前验证 baseWorkflowDigest，并从 plan material 重算 planDigest、event IDs 和 summary。
- 坏 batch 返回 `JOURNAL_CORRUPT`，不暴露部分 workflow。
- 原子 replace 探针不通过时 apply 关闭；故障注入覆盖受支持平台的进程退出，不把未验证的断电行为声称为通过。
- 原子 replace 探针只控制 batch apply；普通 Runner/canonical event append 保持可用，并在开始写入后的失败结果不确定时 fence service。
- journal 以 chunk 级预算在整体回读前拒绝超过 3 MiB 的 import batch 和超过 4 MiB 的任意记录；3–4 MiB 的 legacy bare event 使用受限临时 spool 并继续可重放。
- Service 的 workflow、WorkItem、Receipt 和 dashboard snapshot 均返回隔离副本，调用方不能绕过 journal 修改内存状态。

## 已关闭的设计问题

- 多来源字段冲突：使用 ExternalLink 的字段管理权，不采用 last-write-wins。
- 字段管理权来源：由 import mapping 显式声明，不由 provider 类型或导入先后顺序推断。
- Provider 编辑：新 revision 产生 observed，只有字段管理者再产生 work_item.updated。
- Provider object mapping：持久化在 ExternalLink 并建立全局唯一索引，不另建首版 mapping aggregate。
- Preview/apply 竞态：planDigest + baseWorkflowDigest + 单进程 write queue。
- Preview/apply 授权竞态：policyDigest + apply 时重验当前 capability/scope。
- 多事件原子性：一个 ImportBatchRecord，通过 staged whole-file replace 提交。
- 重试未知结果：按 planDigest 查询不可变 ImportReceipt。

本规格的 preview 与 atomic apply 技术验证已经闭环。CLI/HTTP apply、provider 外部写回、多进程 writer 和断电 durability 仍属于后续独立切片。
