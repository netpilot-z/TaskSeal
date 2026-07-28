# 工作跟踪规范

## 目标

TaskSeal 使用 Linear 管理内部产品研发工作，使用 GitHub 管理代码交付与面向仓库使用者的问题。两者通过稳定 Issue identifier 和 Pull Request 关联，而不是维护两套重复的产品待办。

本规范自 2026-07-28 起生效。

## 系统职责

| 对象 | 权威系统 | 说明 |
| --- | --- | --- |
| 产品方向、Feature、Research、Refactor、内部 Task | Linear | 进入 Project `TaskSeal`，由 Team `netpilot` 管理。 |
| 执行状态、优先级、依赖、负责人、验收结果 | Linear | Agent 完成运行不等于验收完成。 |
| 分支、Commit、Pull Request、Review、CI、Release | GitHub | PR 必须关联 Linear identifier。 |
| 外部 Bug、兼容性问题、公开 Feature Request | GitHub Issue | 确认进入内部研发后，创建 Linear Issue 并建立双向链接。 |
| 安全漏洞 | GitHub Security Advisory 或私有安全流程 | 不进入公开 Issue。 |

仓库中的 `docs/tickets/` 保存可审查的规格拆分和 bootstrap 输入，不是第二个在线任务系统。`0006-linear-bootstrap-manifest.md` 只保留未完成且尚未映射的条目；Linear 映射建立后必须移除对应 manifest 项，不得仅在 Markdown 中推进远端任务状态。

## Linear 生命周期

当前 Team 使用以下既有状态，不在本阶段修改 Workspace workflow：

```text
Backlog → Todo → In Progress → Done
```

- `Backlog`：已经记录，但尚未承诺进入近期执行。
- `Todo`：依赖和验收标准清楚，可以领取。
- `In Progress`：已有一个受控执行 owner；Agent Attempt、PR review 和验收准备都保留在该状态。
- `Done`：Artifact、Required Evidence 和人工 `AcceptanceDecision` 全部通过。
- `Canceled` / `Duplicate`：由人工确认后使用，不能由 Agent 根据标题猜测。

当前没有独立 `In Review` 状态。评审阶段由 TaskSeal WorkItem、PR 和 Evidence 表达；未来若确需新增状态，应单独修改 workflow 并更新映射合同。

## 分支与 Pull Request

分支使用：

```text
feature/np-123-short-slug
fix/np-123-short-slug
refactor/np-123-short-slug
docs/np-123-short-slug
chore/np-123-short-slug
```

Pull Request 标题以 `[NP-123]` 开头，正文使用 `Implements NP-123` 或 `Refs NP-123`。只有真正完成对应验收范围时使用 `Implements`。

合并 PR 只证明代码交付物进入主线。TaskSeal 必须收集 CI、审查等 Required Evidence，并形成接受决定后，才允许把 Linear Issue 迁移到 `Done`。

## 创建、更新与关闭约束

1. 外部写必须先解析并绑定 Organization、Team、Project 和 State UUID。
2. 标题、URL 和时间不能作为去重身份；创建前持久化 client UUID 和 source intent。
3. 审批必须绑定实际 Project/State、payload、operation digest 和稳定 source ticket。
4. 请求已派发但结果不确定时，只能按 client UUID reconcile，不能重试 create。
5. Agent 不得仅因运行完成而关闭 Issue。
6. Project/State、Artifact、Evidence 或 Acceptance 发生漂移时失败关闭并交由人工处理。

## GitHub 历史迁移

- 已关闭的历史 GitHub Issues 保留为交付记录，不在 Linear 重新创建开放副本。
- 内部规划 Issues `#7`、`#25`、`#32` 已分别迁移到 `NP-3`、`NP-11`、`NP-10`。
- 迁移时在 GitHub 留下 Linear identifier 和链接，再以 `moved to Linear` 关闭；在成功核验前不得先关闭。
- 后续 GitHub Issue 只有在外部 Bug、公开反馈或仓库级维护问题语义下创建。

## 当前写入门禁

操作者已为 `LINEAR_API_KEY` 配置 Issue 创建、更新和评论权限；`NP-1` 与 `NP-2`～`NP-12` 已通过精确 UUID mutation 与读后核验确认。Linear 的 `issueRelationCreate` 另需通用 `write` scope，当前失败关闭且没有创建任何原生依赖关系。权限可用不等于 TaskSeal v1 获得自动写授权：

- 人工授权的 tracker bootstrap 可以创建和维护本轮 Linear 任务；
- TaskSeal runtime 在 Operation v2 完成前仍不接入真实 mutation；
- 不回退到新建 GitHub 规划 Issue；
- 自动 submit 必须继续遵守 Project/State/source intent digest、人工审批、journal-before-transport 和 UUID reconcile。
