# Linear Ready Work Intake

## 目标

TaskSeal 从配置的 Linear Organization、Team、Project 与 `Todo` 状态读取候选任务，由操作者按 Issue UUID 显式选择一张，再通过既有 Snapshot Import 创建或关联本地 WorkItem。

本规格只建立“读取与本地接入”闭环。它不自动选择任务、不启动 Runner、不修改 Linear，也不把标题、URL 或自由文本描述当作身份或依赖关系。

## 配置

`config/project.json` 的 `linear.readyWork` 必须显式提供：

- `enabled`：ready-work composition 开关；
- `readyState`：必须解析为 `unstarted` 类型；
- `completedState`：必须解析为 `completed` 类型；
- `dependencyIndex`：仓库内 JSON 相对路径。

缺字段、未知字段、本地绝对路径、路径穿越、Windows ADS/保留名、非安全路径段、canonical path 逃逸、非普通文件、超过 512 KiB 的索引、同名 ready/completed state 均失败关闭。关闭开关时不构造 Linear exchange，不发网络请求，现有 `taskseal run <work-item-id>` 保持不变。

## 只读合同

scope resolver 复用 bootstrap 已验证的分页与身份规则，唯一解析并对账：

1. authenticated Organization；
2. configured Team；
3. configured Project 及其 Team membership；
4. Team 内的 Todo 与 Done workflow state。

ready Issue query 只使用精确 Team、Project、State UUID filter，固定每页 50、最多 20 页，并在客户端逐节点再次对账 Team、Project、State。重复/空 cursor、跨页同 UUID 内容漂移、超页、GraphQL error、HTTP uncertainty、响应超限或 scope drift 均不返回部分结果。

Issue 身份固定为小写 Linear UUID；identifier 只用于展示。原生 `inverseRelations(type=blocks)` 归一为 blocker UUID。嵌套 relation 未完整返回时，依赖完整性为 `unknown`。

## 过渡依赖索引

原生 Linear relation 尚未获得通用 `write` scope，因此首版严格解析 bootstrap map 中的稳定 UUID 边：

- `dependsOnTickets` 与 `relations` 必须一一对应；
- `target.organizationId/teamId/projectId/stateId` 必须完整且为 UUID，前三者必须与本次 resolved ready-work scope 精确一致；
- blocking/blocked ticket 与两个 Linear UUID 必须精确匹配；
- 重复 ticket、UUID、relation 或未知 endpoint 使整个索引无效；
- 未迁移的 prerequisite 使该 Issue 的依赖完整性为 `unknown`；
- 不在过渡索引中的新 Issue 标记为 `unindexed`，由完整的原生 relation 结果决定，不把历史 map 误作 allowlist；
- 索引只提供边，依赖实时状态仍按 UUID 从 Linear 读取。

原生 relation 与本地声明边取并集。只有依赖集合完整、每个依赖都处于配置的 Done UUID 且 type 为 `completed`，候选才是 `ready`。Canceled、Backlog、Todo、In Progress、missing、foreign scope 与 unknown 都不能通过。

该索引是可替换的 `LinearDependencyIndexPort`，不是第二套在线状态账本。

## 显式选择与本地应用

CLI 分三步：

```text
taskseal ready linear
taskseal ready linear --mode preview --issue <uuid> --work-item <id> --criterion <key>
taskseal ready linear --mode apply --issue <uuid> --work-item <id> --criterion <key> --expected-plan-digest <sha256>
```

- list 只读远端并输出裁剪候选，不打开或重放本地 canonical journal；
- preview 重新读取候选与依赖，生成现有 ImportPlan；
- apply 再次执行同一门禁，要求 reviewed plan digest 精确一致。

单张 Issue 才会构造 ProviderSnapshot v2。稳定 `linear:issue:<uuid>` 进入 rich ExternalLink；create、link、refresh、mapping conflict、policy、provenance、atomic batch、receipt idempotency 与 reopen replay 全部复用既有 Snapshot Import。相同 scope、mapping、revision 与 content 已链接时，preview 返回 `already_linked`。

apply 先只重放本地 journal 并按 reviewed digest 查询已验证的 batch context。只有 receipt、PolicyBinding、全部 action source、WorkItem、Linear rich link 与 mapping 完整绑定本次 Issue UUID/WorkItem/Evidence 时，才在读取配置、凭证或 Provider 前返回 `idempotent`；该 receipt replay 输出 `issueId` 与 `receiptReplay: true`，不伪造未重新读取的 live candidate。未命中才进入实时 eligibility 与新 apply；错误 digest、错误 source/mapping 或不存在的 receipt 不得被报告为成功，也不追加空 batch。

apply 只写本地 canonical journal，输出 `linearWrites: 0`。apply-time Linear provenance re-read 仍绑定 UUID、Team、revision、title 与 digest；Project/Todo/依赖 eligibility 是派发前短生命周期门禁，不宣称与 Linear 形成原子租约。

## 安全与回退

- GraphQL 文档全部是 query，没有 mutation；
- 使用固定 endpoint、单凭证、15 秒 timeout、128 KiB request 与 64 KiB streaming response；
- 错误只暴露固定 code/message，不返回 Token、raw body 或 provider 错误正文；
- committed receipt replay 保持离线，且不受 ready-work 开关或当前授权变化影响；
- 首版不持久化 ready queue，不修改 Domain Event schema；
- 禁用 `linear.readyWork.enabled` 后零 ready-work 网络调用，本地 WorkItem 与 Runner 路径不变；
- Control Room 任务选择、cancel、retry 与 bounded concurrency 属于 T17。

## 验收与验证

- exact Project/Todo/Done scope；
- Issue 与 relation 有界分页；
- stable UUID create/link；
- declared/native dependency union 与实时 Done gate；
- unindexed 新 Issue 不受历史 bootstrap map allowlist 限制；
- missing/foreign dependency-index target 在 Issue 读取前失败关闭；
- blocked/unknown 时零 import；
- preview/apply digest 门禁；
- exact duplicate、offline receipt retry、restart/replay 与 mapping conflict；
- disabled feature 零网络；
- 真实 Linear list smoke 前后本地 journal hash 不变。
