# 规格 0021：人工验收与 Linear Done 受控迁移

## 目标

为 NP-7 跑通以下可复核闭环：

```text
current successful Attempt
  + current Artifact revision
  + all latest Required Evidence passed
  + accountable human decision
  → local accepted
  → controlled Linear state transition
  → exact read-after-write
```

本规格不允许 Agent 自己批准，不自动关闭失败任务，不删除 Issue，也不把远端同步失败伪装为本地验收失败。

## Acceptance Review v1

每个 WorkItem 暴露确定性的 `reviewRevision`，摘要至少绑定：

- WorkItem ID 与当前 status；
- 当前 AcceptanceDecision 或 `null`；
- active Attempt ID、status、runtime outcome、completedAt；
- active Artifact ID、revision、linkedAt；
- 排序后的 Required Evidence；
- 每项 criterion 的 latest current-revision Evidence ID、outcome、recordedAt。

摘要 domain 为 `taskseal.acceptance-review:v1`。浏览器必须提交它，领域层在串行 write queue 内重算并比较；新 Attempt、新 Artifact revision、新 Evidence 或另一项 Decision 都会使旧页面 stale。

## Acceptance Decision v2

新命令只写 exact-key v2 payload：

```text
decision: accepted | rejected
actor: <server-owned stable local operator id>
reason: <bounded human reason>
decisionId: <UUID v4>
expectedReviewRevision: <sha256 digest>
```

规则：

1. legacy 三字段 `acceptance.decided` 继续可 replay；新 API 只写 v2。
2. v2 actor 使用受控写相同的稳定非敏感 ID 规则；浏览器 body 不携带 actor。
3. v2 reason 必填、有界并拒绝不安全控制字符。
4. 决策发生时间必须不早于所绑定 Attempt、Artifact 与 latest Evidence。
5. accepted 继续要求当前 Attempt completed、当前 Artifact 存在、全部 latest Required Evidence passed。
6. rejected 只允许已有 terminal Attempt 的 reviewing/blocked basis；不访问 Linear。
7. 同一 review basis 只能产生一个 v2 Decision；并发第二项 Decision 因 revision stale 失败。
8. WorkItem 保存 decision history；新 Attempt 清除 current decision，但保留拒绝审计。
9. accepted WorkItem 不得通过普通 Run 隐式开启新 Attempt；后续 reopen 必须另立显式合同。

## Transition Operation v3

```text
schemaVersion: 3
provider: linear
capability: acceptance.write
action: work-item.transition
configuredTarget:
  kind: issue_state
  key: <workspace/team/project/from-state/to-state derived key>
  workspace: <ref>
  team: <ref>
  project: <ref>
  expectedState: <ref>
  targetState: <ref>
resolvedTarget:
  organizationId: <UUID>
  teamId: <UUID>
  projectId: <UUID>
  issueId: <UUID>
  expectedStateId: <UUID>
  expectedRevisionId: <canonical timestamp>
  targetStateId: <UUID>
sourceIntent:
  kind: taskseal.acceptance-decision
  workItemId: <WorkItem ID>
  decisionId: <UUID v4>
  reviewRevision: <sha256>
  acceptanceDigest: <sha256>
operationKey: <sha256>
planDigest: <sha256>
```

Operation status：

```text
approval_required
  ├─ approve → approved
  └─ reject → rejected

approved
  └─ begin_submission → submitting

submitting
  ├─ transition_confirmed → transitioned
  ├─ not_dispatched → failed
  └─ outcome_unknown → outcome_unknown

outcome_unknown
  └─ begin_reconciliation → reconciling

reconciling
  ├─ target_confirmed → reconciled
  ├─ expected_state_unchanged → reconciliation_absent
  └─ failure / drift → outcome_unknown
```

成功观察只保存白名单字段：Issue ID/identifier、Organization/Team/Project/State UUID 和 `updatedAt`。plan、approval 与观察结果必须由 exact parser 和相邻 pair validator 复核。

## Coordinator 顺序

1. 在 TaskSealService write queue 内验证 `expectedReviewRevision` 并 journal-first 追加本地 Decision。
2. Reject 返回本地结果，不创建 operation。
3. Accept 再读 WorkItem，必须仍是同一 v2 accepted Decision。
4. fresh read 同一 Linear UUID，核对 configured scope、Project、expected State 与 `updatedAt`。
5. journal-first 创建 `approval_required` v3 plan，并由同一 server-owned human actor 批准 exact plan digest。
6. submit 前再次检查本地 accepted Decision 与 Linear precondition。
7. 先原子提交 `submitting` version；只有 `resolution: committed` 才能消费一次 mutation permit。
8. mutation 只发送 `{ stateId: targetStateId }`。
9. mutation 后独立读取同一 UUID；只有 exact scope + target State 才记为 `transitioned`。
10. response lost、读回失败或 journal commit unknown 按受控写 fence 处理，绝不盲重发。

## Control Room

- Persistent runtime 通过 `TASKSEAL_HUMAN_ACTOR` 固定本机操作者；缺失时验收能力关闭。
- 配置 `linear.acceptance.enabled` 默认 `false`；关闭时 local accept/reject 仍可按显式产品选择开放，但 Linear transition 固定零网络。
- Endpoint：`POST /api/work-items/:id/acceptance`。
- Body：`decisionId`、`decision`、`reason`、`expectedReviewRevision`；必须 exact-key。
- 复用 loopback Host、Origin、Fetch-Site、JSON 与 CSRF 门禁。
- Dashboard 分开显示 `Local acceptance` 与 `Linear Done sync`。

## 验收标准

1. stale browser、新 Attempt、新 head、新 Evidence 和并发相反决定都不能验收旧 basis。
2. actor 由 server 注入，body 不能冒充。
3. reject reason/history 可审计，且 Linear mutation 次数为 0。
4. accepted 才能生成 Transition Operation；唯一 rich Linear link 和同一 UUID 必须成立。
5. permit 前失败、配置关闭、无凭证、scope/state/revision drift 都是零 mutation。
6. response lost 与 restart 只允许 exact query reconcile，不允许第二次 mutation。
7. 本地 accepted 与远端 unknown/failed/disabled 可同时真实展示。
8. v1/v2 Create golden bytes、摘要、journal replay 和投影行为不回归。
