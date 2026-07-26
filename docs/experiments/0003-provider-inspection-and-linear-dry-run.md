# 实验 0003：Provider inspection 与 Linear dry-run

## 实验卡

- 决策：真实 GitHub/Linear payload 是否能在零外部写入条件下进入 TaskSeal canonical event 契约；仓库 tickets 是否能先形成确定性 Linear 草案供人工审查。
- 假设：固定 provider read contract、精确 scope 校验和显式本地映射足以替换 fixture 中虚构的 `taskSeal.*` 字段；dry-run 可以完全离线。
- 反证：Token 进入输出；客户端发送非只读请求；scope 漂移被静默接受；Check 不绑定 PR head SHA；相同 ticket 输入产生不同草案；dry-run 连接或修改 Linear。
- 边界：单仓库、单 Issue/PR/Check、单 Linear Issue、一个 criterion；无 snapshot import、Webhook、缓存、重试调度和 provider 写入。

## 实际结果

- GitHub 客户端固定 REST API `2026-03-10`、GitHub.com API origin、GET、官方请求头和有界同源分页。
- GitHub Issue、PR、Check 分别与显式 WorkItem、Attempt、Artifact、criterion 映射组合；唯一已完成 Check 必须匹配 PR `head.sha`。
- Linear 客户端显式区分 personal API key 与 OAuth access token，分页解析 Organization/Team，并在读取 Issue 前精确校验 workspace/team。
- Linear HTTP 200 中的 GraphQL errors、限流、scope 漂移、Issue team 漂移和认证冲突都失败关闭。
- fixture 已移除 provider 不会返回的 `taskSeal.*` 字段；normalizer 只接受独立 mapping 参数。
- mocked-real GitHub snapshot 与 Codex Attempt 在内存重放后进入 `reviewing`，通过的 Check 成为当前 revision 的 Evidence；未写入 journal。
- CLI 提供 `inspect github-issue`、`inspect github`、`inspect linear` 与 `sync linear --dry-run`，参数错误为退出码 2，provider/配置失败为退出码 1。
- 仓库八个 tickets 两次 dry-run 输出一致，`networkRequests=0`、`externalWrites=0`、`mutationReady=false`。

## 真实只读 smoke

首次真实调用按预期失败关闭：

```text
GitHub: GITHUB_NOT_FOUND
Linear: LINEAR_WORKSPACE_MISMATCH
```

GitHub 失败原因是公开仓库当前为空，没有 Issue/PR/Check 样本。Linear 失败发生在 Issue 查询前，因为配置 workspace `TaskSeal` 与凭证实际 Organization `netpilot-z` 不一致。这些是外部样本与坐标问题，不是通过写入样本或猜测映射绕过的实现错误。

操作者随后确认真实坐标并将 `NP-1` 关联到 Linear Project `TaskSeal`。配置修正为 Workspace `netpilot-z`、Team `netpilot` 后，完整只读 inspection 成功：

```text
provider: linear
mode: read-only
workspace: netpilot-z
team: netpilot (NP)
project: TaskSeal
issue: NP-1
workItemId: TS-1
event: work_item.created
journal unchanged: true
```

snapshot 只输出经过裁剪的 scope、source reference、mapping 与 canonical event；没有保存凭证或 raw response。

操作者随后明确授权在 `netpilot-z/TaskSeal` 创建一个联调 Issue。TaskSeal 先按固定标记执行幂等检查，然后只创建 GitHub Issue `#1`，未设置负责人、标签或里程碑，也未创建 PR、Push、触发 CI 或关闭 Issue。新增的 Issue-only 只读切片真实执行结果为：

```text
provider: github
mode: read-only
repository: netpilot-z/TaskSeal
issue: #1
workItemId: TS-1
event: work_item.created
journal unchanged: true
```

这次外部创建是一次有明确目标和范围的操作者授权动作，不是 `inspect` 的隐式副作用。`inspect github-issue` 本身仍只发送 GET。

操作者随后授权完成 PR/Check 联调。空仓库先以已验证项目状态建立基线，并从 `feature/github-delivery-smoke` 创建 Draft PR `#2`；操作者之后要求将默认主线重命名为 `master`，GitHub 自动迁移 PR base。CI 只授予 `contents: read`，官方 Action 固定到完整 commit SHA，checkout 不持久化 GitHub 凭证，唯一 job/check 名称为 `tests`。

首次 CI 正确触发，但暴露了一个真实跨平台问题：通用 doctor 测试硬编码断言 Windows 的 `codex-path.exe`，Linux runner 实际正确使用 `codex`。测试改为按 `process.platform` 精确断言后，本地 114 项测试和 GitHub `tests` Check 均通过。完整 GitHub inspection 结果为：

```text
provider: github
mode: read-only
issue: #1
pullRequest: #2
verified PR head revision: f7a3d90da46b6f28d4a95137f54f64af2acd1e5b
verified Check head_sha: f7a3d90da46b6f28d4a95137f54f64af2acd1e5b
check: tests
check id: 89805420797
check conclusion: success
mapping: TS-1 / github-live-2 / tests
events: work_item.created, artifact.linked, evidence.recorded
journal unchanged: true
```

上述完整 SHA 是首次成功完整 smoke 的不可变 revision 证据；后续文档提交不会改写这次历史结果。真实 snapshot 与显式 completed Attempt 在内存重放后得到 `reviewing`、Evidence passed、AcceptanceDecision null。这证明成功的 CI 证据仍不会绕过 Owner acceptance。PR 保持 Draft，Issue 保持 open；没有 merge、自动关闭或 snapshot import。

## 得到的结论

Provider contract、显式映射和离线 dry-run 假设已在 mocked-real 与真实 GitHub/Linear 样本中成立。TaskSeal 已经具备首个插件式边界的雏形：provider client 只负责读取事实，normalizer 接受独立映射，领域只接收 canonical events。

T05/T07 的 Linear 与 GitHub 真实成功样本已经完成。现在仍不应直接进入 Linear 自动创建、GitHub 自动关闭或无人审批 import；下一步是规格化 snapshot import 的 ExternalLink、update、冲突、幂等、审计和 preview/apply 边界。

## 已知风险

- snapshot 仍是一次性预览；Linear/GitHub Issue 编辑需要 `work_item.updated` 或 import 冲突语义。
- 一个既有 WorkItem 暂时不能通过事件追加第二个 ExternalLink。
- GitHub Issue 与 PR 关联由操作者显式声明，尚未验证 timeline cross-reference 或 Development sidebar 关系。
- Check Runs 不覆盖 Commit Statuses；首个实验只面向 GitHub Actions 风格 Check。
- provider 客户端没有缓存、条件请求、生产级重试、限流等待或 OAuth 生命周期管理。
- dry-run 的草案键基于可变名称，只用于预览；真实写入必须改用解析后的 Organization/Team UUID、持久 client UUID、operation key 与查询对账。
