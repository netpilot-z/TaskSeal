# TaskSeal 上下文

## 一句话定位

TaskSeal 让人类和 AI Agent 的“已完成”变成有证据、可验收、可追责的交付结果。

## 当前验证范围

当前最快验证路线覆盖两条软件交付链路：

- fixture：`Linear WorkItem → Codex Attempt → GitHub Artifact/Evidence → AcceptanceDecision`
- persistent：`Local WorkItem → Codex App Server Attempt → Control Room`
- provider inspection：`GitHub/Linear read-only fact → explicit mapping → canonical snapshot`

本阶段不构建通用 Agent 市场、多租户权限、计费、生产数据库或真实外部写入。Linear workspace `netpilot-z`、team `netpilot` 与 project `TaskSeal` 是已只读验证的真实坐标；仓库 tickets 默认不自动同步。

当前真实环境中，Linear Issue `NP-1` 已完成成功 snapshot；GitHub Issue `#1`、Draft PR `#2` 与 PR head 上的 `tests` Check 已完成完整只读 snapshot 和真实内存重放。结果进入 `reviewing`，Evidence passed，AcceptanceDecision 仍为空，journal 未变化。Issue、PR 与 CI 的创建均来自操作者明确授权；TaskSeal 不会从只读检查隐式创建、更新、合并或关闭外部对象。

## 统一语言

| 名称 | 含义 |
| --- | --- |
| `WorkItem` | 需要交付并验收的最小工作单元，可关联外部 Issue。 |
| `Attempt` | 某个 Agent 对一个 WorkItem 的一次执行。失败重试会产生新 Attempt。 |
| `Artifact` | 执行产生的交付物，例如 Pull Request、文档、视频或报告。 |
| `Evidence` | 支持验收判断的可复核事实，例如测试结果、截图、审查结论。 |
| `AcceptanceDecision` | 对 WorkItem 作出的接受或拒绝决定。 |
| `ExternalLink` | TaskSeal 对 GitHub、Linear 等外部对象的稳定引用。 |

## 核心不变量

1. Agent 声称完成不等于 WorkItem 已验收。
2. 接受决定必须建立在交付物和全部必需证据通过的基础上。
3. 同一个外部事件重复投递不得产生重复 Attempt、Artifact 或 Evidence。
4. TaskSeal 保存自身状态，但不冒充 GitHub、Linear 或 Agent Runtime 的事实来源。
5. Codex turn completed 只是 Attempt 终态；没有当前 Artifact、Required Evidence 和 accountable owner 时不得 accepted。
6. 只有成功 completed 的当前 Attempt 才能进入 accepted；失败或中断终态不能被晚到的 Artifact/Evidence 隐式解除。
7. 较旧的外部事实不得清除较新的人类验收决定；失败或中断 Attempt 只有通过新的 Attempt 才能重新开启。
8. Provider payload 与 TaskSeal 关联映射必须分离；WorkItem、Attempt、Artifact 与 criterion 关联不得由标题、时间或第一条结果猜测。
9. 读取与写入是独立能力；只读 Token、snapshot 或 dry-run 不能隐式获得外部创建、更新、关闭或 merge 权限。
