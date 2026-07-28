# 规格 0016：Linear Tracker Bootstrap 基础

## 目标

为“Linear 内部任务 → Agent 执行 → GitHub 交付证据 → 人工验收 → Linear Done”建立第一个不会绕过审批和历史回放的真实 Provider 基础。

本规格对应 Linear `NP-1` 的首个实现切片。

## 当前问题

现有能力分成两条尚未连接的路径：

```text
ProjectConfiguration → Markdown dry-run

ControlledWriteOperation v1
  → Operation Journal
  → Coordinator
  → injected fake Linear transport
```

v1 Operation 只绑定 Organization/Team UUID 和 title/description。直接在 transport 或运行时配置中补 `projectId/stateId`，会让实际写入位置脱离 `planDigest`、人工审批和 journal；直接扩展 v1 exact-key schema 又会破坏旧 journal replay。

因此本切片只交付只读 resolver 和真实但未接线的 HTTP exchange，不执行 mutation。

## 配置合同

非敏感配置显式声明：

```json
{
  "linear": {
    "workspace": "netpilot-z",
    "team": "netpilot",
    "project": "TaskSeal",
    "backlogState": "Backlog"
  }
}
```

- 既有 `getLinearCoordinates()` 保持只返回 workspace/team，兼容已有 inspection。
- 新增 `getLinearBootstrapCoordinates()`，要求四个引用都存在、非空且已经 trim。
- `project` 不再从顶层本地项目名隐式推断。
- `backlogState` 没有默认值，避免 Workspace workflow 变化后静默写入错误状态。

## Scope Resolver

Connector 通过只读 GraphQL 分页解析并返回：

```text
organizationId
teamId
teamKey
projectId
stateId
```

成功必须同时证明：

1. workspace 与 authenticated Organization 的 name 或 urlKey 匹配；
2. Team name/key 唯一匹配；
3. Project name 唯一匹配；
4. Project 的 Team connection 包含已解析 Team；
5. State 属于该 Team，名称唯一匹配；
6. State 的远端 `type` 必须是 `backlog`。

每页最多 50 个节点，任一 connection 最多 20 页；重复/空游标、分页期间 identity 漂移、零匹配或多匹配全部失败关闭。解析结果只返回调用者，不缓存、不落盘，也不授予写权限。

## Bounded HTTP Exchange

真实 GraphQL exchange 具备以下边界：

- 固定 endpoint `https://api.linear.app/graphql`；
- 固定 `POST`、JSON content type 和 `redirect: error`；
- personal API key 与 OAuth access token 必须二选一；
- request 最大 128 KiB；
- response 使用 stream reader，最大 64 KiB；
- timeout 为正整数且不超过 15 秒；
- fetch 前可证明的非法输入返回 `not_dispatched`；
- 一旦调用 fetch，throw、abort、响应读取失败和超限统一返回 `response_lost`；
- credential、底层异常和 GraphQL raw error 不进入公共错误。

Exchange 的返回合同兼容现有 injected transport，但本切片不把它注入 coordinator、CLI、HTTP 或 Control Room。

## Dry-run 修正

Linear ticket dry-run 的目标 Project、标题和 intent digest 使用 `linear.project`，不再使用顶层本地 `project`。默认 source 改为只包含未完成且尚未映射项的 `0006-linear-bootstrap-manifest.md`；任意 source 中状态以“已完成”或 `completed` 开头的 ticket 都不会生成草案。输出仍为 schema v1、`mutationReady: false`、零网络和零外部写入。

## 兼容与回退

- 不修改 `ControlledWriteOperation v1`、Operation Journal container、Coordinator 或现有 fake transport。
- 历史 v1 records 继续 exact parse 和 digest replay。
- 删除新 resolver/exchange/accessor 即可回退；本切片没有 persisted schema writer，也没有产生 Linear mutation。
- 真实写入必须等待 reader-first 的 Operation v2，使 project/state/source intent 成为审批与 digest 的一部分。

## 验收标准

- 配置缺少 project/backlogState 时失败，旧 workspace/team accessor 行为不变。
- 默认 dry-run 不读取历史已完成里程碑，显式 source 中的已完成 ticket 也被排除。
- workspace/team/project/state 唯一解析成功；Project-Team 和 State-Team 关系被验证。
- 非 backlog 同名 State、歧义对象、重复游标、超页和不可信响应失败关闭。
- 原生 fetch `Response`、分块 body、request/response limit、timeout、认证冲突和 secret redaction 有自动化测试。
- 真实环境只读 smoke 能解析 `netpilot-z / netpilot / TaskSeal / Backlog`，mutation 数为零。
- TypeScript 门禁、定向测试和全量回归通过。

## 后续切片

1. Operation v2：把 project/state/source intent 纳入 plan digest、approval 和 journal reader union。
2. Project-aware create/query：mutation 与 read-after-write 同时核验 Team、Project、State。
3. Backlog bootstrap：只对未完成 manifest prepare，逐项人工 approve/submit/reconcile。
4. ready-work ingestion、Agent execution、Artifact/Evidence、Acceptance 和 Done transition。
