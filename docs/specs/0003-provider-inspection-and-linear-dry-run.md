# 规格 0003：Provider 只读检查与 Linear dry-run

## 背景

TaskSeal 已用 fixture 证明 `WorkItem → Attempt → Artifact → Evidence → Acceptance` 领域闭环，并用 Codex App Server 证明真实 Attempt 生命周期。下一步需要验证真实 GitHub/Linear payload 能否在不写外部系统的前提下进入同一个 canonical event 契约。

现有 fixture 把 `taskSeal.*` 映射字段伪装成 provider payload 的一部分，真实 GitHub/Linear API 不会返回这些字段。本规格把来源事实与 TaskSeal 本地关联明确分离。

## 目标

- 只读获取一个 GitHub Issue、显式指定的 PR 和 PR head SHA 上的指定 Check Run。
- 在完整交付样本尚未就绪时，允许独立只读检查一个 GitHub Issue。
- 只读解析 Linear Organization/Team，并获取一个显式指定的 Issue。
- 使用调用方提供的 WorkItem、Attempt、criterion 等映射生成 canonical events。
- 只在内存中预览和重放 snapshot，不写 journal，不修改 provider。
- 将仓库 ticket 文档确定性映射为 Linear Issue 草案，不调用 Linear API。

## 非目标

- 自动发现 GitHub Issue 与 PR 的强关联。
- 导入 snapshot 到 `.taskseal/events.jsonl`。
- 创建、更新、评论、关闭或移动任何 GitHub/Linear 对象。
- OAuth UI、Token 存储、Webhook、缓存、重试调度和 provider 写适配器。
- 同时把 Linear Issue 与 GitHub Issue 作为同一个 WorkItem 的多个 ExternalLink。

## CLI 契约

```text
taskseal inspect github-issue \
  --issue <number> \
  --work-item <id> \
  --criterion <key>

taskseal inspect github \
  --issue <number> \
  --pr <number> \
  --check <name> \
  --work-item <id> \
  --attempt <id> \
  --criterion <key>

taskseal inspect linear \
  --issue <identifier-or-uuid> \
  --work-item <id> \
  --criterion <key>

taskseal sync linear --dry-run \
  [--source docs/tickets/0002-codex-runner-milestone.md]
```

`inspect` 成功时输出经过裁剪的 JSON snapshot；provider、配置或映射错误返回退出码 1；参数错误返回退出码 2。snapshot 不包含 Token、请求头、原始响应、当前工作目录或本地绝对路径。

`sync linear --dry-run` 只读取项目配置与仓库内 Markdown。`--source` 解析后的路径必须仍位于项目根目录内，输出只使用仓库相对路径。

## 配置与认证

非敏感坐标继续读取 `config/project.json`：

```json
{
  "github": {
    "repository": "owner/repository"
  },
  "linear": {
    "workspace": "workspace-name",
    "team": "team-name-or-key"
  }
}
```

认证只从环境读取：

- GitHub：`GITHUB_TOKEN`，其次 `GH_TOKEN`；未提供时对公开仓库匿名读取。
- Linear personal API key：`LINEAR_API_KEY`。
- Linear OAuth access token：`LINEAR_ACCESS_TOKEN`。

Linear 两种凭证同时存在时拒绝执行。任何错误都不得回显凭证或未经裁剪的响应正文。

## 显式映射

Provider payload 与 TaskSeal 映射分别传入 normalizer：

```text
Linear Issue + { workItemId, requiredEvidence }
GitHub Issue + { workItemId, requiredEvidence }
GitHub PR + { workItemId, attemptId }
GitHub Check + { workItemId, attemptId, artifactId, criterionKey }
```

fixture 中不再保存 `taskSeal.*` 字段。缺少映射直接失败，不能回退为标题、编号或时间推断。

GitHub Issue-only snapshot 产生 `work_item.created`；完整 GitHub snapshot 产生 `work_item.created`、`artifact.linked` 与 `evidence.recorded`。Linear snapshot 产生 `work_item.created`。它们分别可以在内存中参与契约重放，但本阶段不把两个来源同时 append 到同一个已有 WorkItem。

## Provider 读取规则

### GitHub

- 固定 `GET`、GitHub REST `2026-03-10` 与 GitHub.com API origin。
- Issue 响应若实际代表 PR 则失败。
- PR 的 `head.sha` 是唯一 Artifact revision。
- Check 查询使用该 SHA、`filter=latest`、精确 `check_name` 和最多 100 条一页。
- 分页只跟随同一 GitHub API origin 的 `rel="next"`，并设置有界页数。
- 只接受唯一、相同 SHA、`status=completed` 的指定 Check。
- 首版只有 `conclusion=success` 归一为 passed，其余终态保守归一为 failed。

### Linear

- 先分页读取当前 Organization 与 teams，再做不区分大小写的完整名称/key 比较。
- workspace 必须与 Organization name 精确匹配。
- team reference 同时匹配 name/key 且结果不唯一时失败。
- scope 校验成功后才允许读取 Issue。
- Issue identifier 的 team key 与返回的 team ID 都必须匹配。
- HTTP 200 中的 GraphQL errors、HTTP 错误、限流、无权限和无结果分别返回稳定错误码。

## Linear ticket dry-run

Markdown 中每个二级 `Txx` ticket 标题生成一个草案。字段包括：

- source ticket 与仓库相对 source。
- 标题、来源状态和结构化描述。
- `dependsOnTickets`、当前 source 之外的 `externalTicketDependencies` 与非 ticket 的 `prerequisites`。
- 基于项目、workspace/team reference、source 与 ticket ID 的稳定 draft idempotency key。
- 基于将来 Issue payload 的稳定 digest。

dry-run 必须明确：

```json
{
  "mode": "dry-run",
  "mutationReady": false,
  "networkRequests": 0,
  "externalWrites": 0
}
```

名称不是长期外键，所以该 key 只用于草案去重。真实写入前必须解析 UUID 并生成持久 operation key。

## 验收标准

1. fake fetch 验证 GitHub 只发 GET、固定版本头、可选 Bearer 认证、head SHA 绑定、分页与安全错误。
2. GitHub Issue-only 检查只读取显式 Issue，生成单个裁剪后的 `work_item.created` snapshot。
3. fake fetch 验证 Linear API key/OAuth header 区别、scope 分页、GraphQL errors、scope/Issue team mismatch 与安全错误。
4. 所有 normalizer 只接受显式映射，fixture 不再包含虚构的 `taskSeal.*` provider 字段。
5. mocked-real snapshot 可与 Codex fixture 在内存中重放到 reviewing/blocked，不写 journal。
6. CLI 参数、成功 JSON、退出码与错误裁剪有自动化测试。
7. Linear dry-run 对相同输入字节级稳定，输出包含依赖、前置条件、幂等键和 digest，且没有网络调用。
8. 真实 GitHub/Linear 只读 smoke 把当前外部阻塞报告为诊断结果；任何样本创建必须有操作者的独立明确授权。
9. `npm test` 通过，项目文件不包含本地绝对路径或凭证。

## 后续边界

真实样本就绪后才评估 snapshot import 和 `external_link.linked` 事件。Linear Issue 创建、状态同步与关闭动作属于新的写入里程碑，需要权限开关、审批、审计、幂等对账和操作者明确授权。
