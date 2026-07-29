# 项目范围 Dogfood 操作手册

本文定义 WorkItem `TS-43` 所要求的项目范围 Dogfood 路径。它是现有
ready-work、Runner、GitHub delivery reconciliation 和人工验收合同的操作说明，
不授予新的外部写权限。

## Linear Project 是硬边界

当前 Dogfood 唯一允许的 Linear 范围是：

- Workspace：`netpilot-z`
- Team：`netpilot`
- Project：`TaskSeal`
- Ready State：`Todo`
- Completed State：`Done`

Project 不是搜索提示或默认值，而是每个阶段都必须重新证明的身份边界。Issue 必须
以 Linear UUID 显式选择，并同时属于以上 Organization、Team、Project 和预期
State。不得按 identifier、标题、URL、分支名或第一条搜索结果猜测关联，也不得接入
无 Project、其他 Project 或 Project 归属不确定的 Issue。

ready list/preview、ready apply 的 provenance re-read，以及最终 Linear transition
前后的读取，都必须得到同一个 Linear Issue UUID 和精确的 Project UUID。Issue 在
preview 后被移出 `TaskSeal`、scope 解析不唯一、Project UUID 漂移或远端无法确认时，
流程失败关闭：不创建本地 import batch、不启动 Runner、不写 GitHub，也不迁移
Linear State。

GitHub 交付同样受显式映射约束。`DeliveryMapping` 必须把上述 Linear Issue UUID、
本地 WorkItem、`netpilot-z/TaskSeal` 中的目标 PR、精确 head identity 和 Required
Evidence selector 绑定在一起。映射只表达允许对账的意图，不能替代 Linear 或
GitHub 的实时事实。

## 唯一允许的交付顺序

以下顺序不可跳步、合并或倒置：

```text
Linear ready preview
  → Linear ready apply
  → explicit Codex App Server Runner dispatch
  → successful current Attempt
  → GitHub Artifact/Evidence preview
  → GitHub Artifact/Evidence apply
  → human AcceptanceDecision
  → controlled Linear Done transition
  → exact Linear Done readback
```

### 1. Preview ready work

操作者先从只读 ready list 取得 Issue UUID，再对单张 Issue 预览：

```bash
node src/cli.ts ready linear \
  --mode preview \
  --issue <linear-issue-uuid> \
  --work-item <local-work-item-id> \
  --criterion <required-evidence-key>
```

preview 必须重新核对精确 Project、`Todo`、原生与声明 blocker 的并集，以及全部依赖
的实时 `Done` 状态。操作者审阅 ImportPlan、WorkItem 映射和 plan digest。preview
不写 canonical journal，也不修改 Linear。

### 2. Apply the reviewed ready plan

使用完全相同的 Issue、WorkItem 和 Evidence 参数提交已审阅的 digest：

```bash
node src/cli.ts ready linear \
  --mode apply \
  --issue <linear-issue-uuid> \
  --work-item <local-work-item-id> \
  --criterion <required-evidence-key> \
  --expected-plan-digest <sha256>
```

apply 必须重跑 eligibility，并在提交前按同一 Issue UUID 重读 Project provenance。
成功时只原子创建或关联本地 WorkItem、rich Linear `ExternalLink` 和 import receipt；
结果必须保持 `linearWrites: 0`。ready apply 不启动 Runner，也不把 Issue 移出
`Todo`。

### 3. Explicitly dispatch the Codex App Server Runner

ready apply 成功后，操作者才可显式派发同一个 WorkItem：

```bash
node src/cli.ts run <local-work-item-id> --prompt "<bounded instruction>"
```

`ManagedAttemptRunner` 负责校验 WorkItem、工作区和权限，持久化唯一的
`attempt.started` / `attempt.finished`；`CodexAppServerRunnerAdapter` 只负责执行。
Codex turn completed 只表示当前 Attempt 成功结束并进入 `reviewing`，不表示交付已被
接受。

Runner 返回的 Artifact/Evidence handoff 只是 bounded untrusted claim。它不能直接
写 canonical Artifact/Evidence，不能作为验收依据，也不能触发 Linear mutation。

### 4. Reconcile GitHub Artifact and Evidence

仓库中的 `DeliveryMapping` 必须已经精确绑定同一 Linear UUID、WorkItem、目标 PR、
head repository/branch，以及每项 Required Evidence 的 Check/Review selector。
先预览：

```bash
node src/cli.ts reconcile github \
  --mode preview \
  --work-item <local-work-item-id>
```

操作者核对目标 PR、当前 head revision、Artifact、Evidence、缺失项和 plan digest，
再应用同一个 reviewed plan：

```bash
node src/cli.ts reconcile github \
  --mode apply \
  --work-item <local-work-item-id> \
  --expected-plan-digest <sha256>
```

apply 会重新采集实时 PR/Check/Review、执行 head fence，并在原子 journal batch 前
重读 provenance。它只写本地 canonical Artifact/Evidence，必须保持
`githubWrites: 0` 和 `linearWrites: 0`。新 PR head 会成为新的 active Artifact
revision；旧 revision Evidence 不得继续满足验收。

### 5. Record the human AcceptanceDecision

accountable human 在 Control Room 审阅当前 `acceptanceReviewRevision` 后提交
`decisionId`、`decision`、`reason` 和 `expectedReviewRevision`。actor 只能由服务端
可信边界注入，Agent 和浏览器都不能提供或模拟 accountable identity。

`accepted` 必须在同一个串行写入边界内重新证明当前 Attempt、Artifact 和全部
Required Evidence。`rejected` 只保存本地可审计决定，不创建 Linear transition。
本地 AcceptanceDecision 必须先于任何 Linear State mutation 持久化。

### 6. Transition the same Linear Issue to Done

只有本地当前决定为 `accepted` 时，TaskSeal 才能为同一 rich Linear UUID 创建并批准
Transition Operation v3。提交前必须 fresh-read 并核对 Organization、Team、
Project、expected State 和 `updatedAt`；journal 必须先提交 `submitting` permit，
之后唯一允许的外部 mutation 才是把该 Issue 的 `stateId` 改为目标 `Done` State。

mutation 后必须独立按同一 Issue UUID 读回。只有 Organization、Team、Project 和
目标 State 全部精确匹配，才能报告 Linear Done 已同步。本地 `accepted` 与 Linear
Done 是两个独立事实；远端 disabled、failed 或 unknown 时不得把两者合并显示为完成。

## Required Evidence 门禁

人工接受前必须同时满足：

1. 当前 active Attempt 存在，且终态为成功 `completed`。
2. 当前 active Artifact 存在，并绑定已对账的目标 PR head revision。
3. WorkItem 声明的每一项 Required Evidence 都存在。
4. 每项 Evidence 都是当前 Artifact revision 上最新的结果，且 outcome 为 `passed`。
5. Check Evidence 绑定精确的 check name 和 GitHub App selector；Review Evidence
   绑定精确 reviewer selector，并已通过 apply-time provenance。
6. AcceptanceDecision 绑定最新 `acceptanceReviewRevision`、服务端拥有的 human
   actor、唯一 decision ID 和有界 reason。
7. Linear transition 绑定该 AcceptanceDecision、同一 Linear UUID、同一 Project、
   expected State/revision、目标 `Done` State 和 exact plan digest。

Agent 的完成声明、Runner summary、handoff claim、PR 标题、分支名、旧 head 的成功
Check、pending/missing Check、普通 Review 评论、日志文本或未经过 provenance 的远端
响应都不是可接受 Evidence。任一 Required Evidence 缺失、失败、过期或归属不确定时，
WorkItem 必须保持未接受。

## 失败关闭与恢复

所有恢复都从可信持久事实重新读取，不手工修改 journal，不猜测远端结果，也不绕过
reviewed digest。

- **ready scope 或依赖失败**：不 import、不派发。修正 Linear Project/State/依赖或
  仓库映射后，从 ready list 和 preview 重新开始；旧 digest 不复用。
- **ready preview/apply 漂移**：Project、State、revision、content 或 plan digest
  任一变化都停止 apply。重新 preview，并由操作者审阅新 digest。
- **Runner failed/interrupted**：WorkItem 保持 `blocked`；晚到 handoff 或 GitHub
  Evidence 不能解除终态。查明原因后显式创建新 Attempt。若 Adapter cleanup 未确认，
  当前 Host 保持 fenced，必须重建 runtime 后才能再次派发。
- **GitHub mapping、head 或 provenance 漂移**：不写 canonical batch。更新受审查的
  mapping（如确有需要），重新 preview 实时 head 并应用新 digest；不得沿用旧 head
  的 Artifact、Evidence 或 receipt。
- **Evidence 缺失或失败**：不创建 accepted Decision。让当前 head 产生所需
  Check/Review 后重新 reconciliation；修复需要代码变更时应形成新的 Attempt 和交付
  revision，而不是改写历史 Evidence。
- **Acceptance review stale**：不接受旧页面 basis。刷新 Control Room，重新审阅当前
  Attempt、Artifact、Evidence 和 `acceptanceReviewRevision`，再由 human 决定。
- **Linear transition 前置条件漂移**：在 mutation 前停止，外部写次数为零。本地
  accepted 保持真实，但 Linear Done 保持未同步；修正 scope/state 后必须重新经过受控
  transition 计划与审批，不能直接更新 Issue。
- **提交结果未知或读回失败**：记录 `outcome_unknown` 并 fence 重提。只能通过
  Control Room 对持久 operation 发起显式 reconcile，按同一 Linear UUID 查询；不得
  第二次发送 mutation。只有 exact Done readback 才能收敛为成功。
- **配置关闭、凭证缺失或 Provider 不可用**：保持零外部 mutation。可保留已经成立的
  本地 accepted，但不得声称 Linear Done；恢复能力后从 fresh precondition read 或
  explicit reconcile 继续。
- **journal/service 要求 reopen**：停止新派发和验收写入，保留持久文件并重建
  runtime，让既有 replay/recovery 逻辑收敛；不得手工编辑 `.taskseal`。

任何阶段都不能通过自动创建/更新 Linear Issue、GitHub comment/merge、重复发送未知
mutation、弱化 Evidence 门禁或让 Agent 自我验收来“恢复”流程。
