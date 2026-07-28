# TaskSeal 项目协作规则

## 项目定位

TaskSeal 是 AI 交付控制平台的技术验证项目。当前阶段只验证跨系统工作项、Agent 执行、交付证据和验收决策能否形成可复核闭环。

## 实施约束

- 项目文件、文档、配置和示例不得包含开发者机器的本地绝对路径。
- 默认使用相对路径、仓库坐标或环境变量描述外部资源。
- 不得提交密钥、Token、Cookie 或真实敏感数据。
- 外部系统默认只读；任何创建 Issue、更新状态、关闭任务、Push 或创建 PR 的动作必须获得明确授权。
- 原型优先使用 Node.js 内置能力，不新增生产依赖，除非先说明验证收益和替代方案。
- 领域规则必须有自动化测试；不得通过弱化断言或删除测试获得绿色结果。

## 当前集成坐标

- GitHub repository：`netpilot-z/TaskSeal`
- Linear workspace：`netpilot-z`
- Linear team：`netpilot`
- Linear project：`TaskSeal`

## 工作跟踪

- 内部产品方向、Feature、Research、Refactor 和 Task 以 Linear 为权威来源。
- GitHub Issue 只用于外部 Bug、兼容性问题、公开 Feature Request 和仓库级维护问题；分支、PR、Review、CI 与 Release 继续使用 GitHub。
- 分支使用 `feature/np-<number>-<slug>`、`fix/np-<number>-<slug>` 等类型前缀，PR 必须关联对应 Linear identifier。
- Agent completed 不等于 Linear Done；只有 Artifact、Required Evidence 和人工 AcceptanceDecision 全部通过后才可迁移完成状态。
- 详细规则与历史迁移边界见 `docs/standards/work-tracking.md`。
