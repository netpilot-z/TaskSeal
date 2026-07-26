# 调研 0001：GitHub 与 Linear 只读契约

## 调研范围

本调研只回答 TaskSeal T05/T06 的最小技术问题：

- 如何只读获取 GitHub Issue、Pull Request 与 Check Run。
- 如何只读解析 Linear workspace、team 与 Issue。
- 如何在不执行 Linear mutation 的前提下生成可审查的 ticket 草案。
- 哪些关联必须由 TaskSeal 显式提供，不能从标题或时间猜测。

核验日期为 2026-07-26。实现固定使用官方文档和公开 API，不把 Token、响应头或原始响应保存到仓库。

## GitHub REST

首个只读切片固定使用 GitHub REST API `2026-03-10`：

```text
GET /repos/{owner}/{repo}/issues/{issue_number}
GET /repos/{owner}/{repo}/pulls/{pull_number}
GET /repos/{owner}/{repo}/commits/{head_sha}/check-runs
```

固定请求头：

```text
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2026-03-10
User-Agent: TaskSeal
```

公开仓库可以匿名读取；私有仓库至少需要目标仓库范围内的 `Issues: read`、`Pull requests: read` 与 `Checks: read`。Token 只允许通过 `Authorization: Bearer ...` 请求头传递。

T05 要求操作者显式传入 Issue 编号、PR 编号、Check 名称、WorkItem ID 与 Attempt ID。首版不从标题、时间或第一条 cross-reference 猜测关联。Check 必须绑定 PR 的 `head.sha`，空结果、未完成、revision 不匹配或多个同名结果都显式失败。

官方依据：

- [REST API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions?apiVersion=2026-03-10)
- [Get an issue](https://docs.github.com/en/rest/issues/issues?apiVersion=2026-03-10#get-an-issue)
- [Get a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10#get-a-pull-request)
- [List check runs for a Git reference](https://docs.github.com/en/rest/checks/runs?apiVersion=2026-03-10#list-check-runs-for-a-git-reference)
- [REST request headers](https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api?apiVersion=2026-03-10#headers)
- [REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api?apiVersion=2026-03-10)

## Linear GraphQL

Linear 只读请求统一发送到：

```text
POST https://api.linear.app/graphql
Content-Type: application/json
```

认证方式由环境变量显式区分：

```text
LINEAR_API_KEY       → Authorization: <API_KEY>
LINEAR_ACCESS_TOKEN  → Authorization: Bearer <ACCESS_TOKEN>
```

两种凭证同时存在时拒绝执行，不能根据 Token 前缀猜测认证类型。Linear workspace 在 API 中对应当前凭证所属的 `Organization`；先读取 organization 和 teams，精确校验配置，再读取指定 Issue。即使 HTTP 状态为 200，只要 GraphQL `errors` 非空也必须失败。

Team 列表按 Relay cursor 分页。Issue 可以使用 UUID 或完整 identifier 读取；若操作者只输入数字，则在 team 已精确解析后用其稳定 key 组装 identifier。Issue 返回后必须再次校验 `issue.team.id`，防止 Issue 移动 team 后旧 identifier 仍可解析。

官方依据：

- [GraphQL API](https://linear.app/developers/graphql)
- [Pagination](https://linear.app/developers/pagination)
- [Rate limiting](https://linear.app/developers/rate-limiting)
- [OAuth 2.0 authentication](https://linear.app/developers/oauth-2-0-authentication)
- [Linear GraphQL schema](https://github.com/linear/linear/blob/d044ca658728db6100cda84233a9545f5ed2f58a/packages/sdk/src/schema.graphql)

## Linear dry-run 与幂等性

Linear 没有文档化的 `validateOnly`、`Idempotency-Key` 或 `clientMutationId` 创建保证。向 GraphQL endpoint 发送 `issueCreate` mutation 就可能产生外部写入，所以 T06 只解析仓库 ticket 文档并生成确定性的本地草案：

- 不调用 Linear endpoint。
- 不生成或发送 mutation。
- 输出配置中的 workspace/team、标题、描述、依赖、前置条件、草案幂等键和 payload digest。
- 输出明确标记 `mutationReady: false`、`networkRequests: 0`、`externalWrites: 0`。

未来真正创建 Issue 时，必须先只读解析并持久化 Organization/Team UUID、为每个操作持久化 UUID v4、operation key 与 payload digest，并在重试前按 UUID 查询对账。该阶段需要新的明确外部写授权。

## 真实环境只读核验结果

首次核验发现两个可复现阻塞：

1. `netpilot-z/TaskSeal` 是公开但尚为空的 GitHub 仓库，目前没有可读取的 Issue、PR 或 Check Run。
2. 初始 Linear 凭证可见的 Organization 为 `netpilot-z`，当时唯一可见 team 为 `Netpilot-z`（key `NET`），与配置中的 workspace `TaskSeal`、team `netpilot` 不一致。

TaskSeal 没有静默改写配置或模糊匹配名称。操作者随后提供了可访问 Team `netpilot (NP)` 的凭证，并确认 Issue `NP-1` 关联 Linear Project `TaskSeal`。Linear API 返回的真实层级为：

```text
Organization / workspace: netpilot-z
Team: netpilot (NP)
Project: TaskSeal
Issue: NP-1
```

在操作者确认后，`config/project.json` 的 workspace 修正为 `netpilot-z`，Linear 真实只读 snapshot 成功且 journal 未变化。操作者另行明确授权创建 GitHub 联调 Issue `#1`，其 Issue-only snapshot 也已成功且 journal 未变化；完整 GitHub 交付 snapshot 当前仍缺关联 PR 与 PR head 上的 completed Check。
