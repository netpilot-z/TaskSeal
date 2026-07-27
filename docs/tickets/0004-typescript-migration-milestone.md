# 里程碑 0004：渐进式 TypeScript 与仓库演进

这些 tickets 是仓库内迁移计划，不会自动同步到 GitHub 或 Linear，也不授权任何外部写入。

## T12.1 — 建立 TypeScript 门禁并迁移项目配置

- 状态：已完成；Node.js 24.12 与当前 Node.js 24 均通过类型和运行验证。
- 目的：用一个低风险垂直切片验证 Node 原生 TypeScript、严格类型检查和 JS/TS 混合运行。
- 范围：开发依赖、锁文件、`tsconfig.json`、CI、`project-config`、doctor 最低版本诊断与对应测试。
- 不包含：领域、runner、CLI/server、浏览器代码、NestJS 和 workspaces。
- 依赖：规格 0005、ADR 0002、实验 0004。
- 验收标准：`npm ci`、`npm run typecheck` 和 `npm test` 通过；生产依赖仍为零。
- 验证：`npm ci` 可复现；配置与 doctor 定向测试通过；`npm test` 115/115 通过；无生成 JavaScript、绝对路径或凭证。

## T12.2 — 迁移领域工作流与总览投影

- 状态：已完成；GitHub Issue `#13`，领域与 dashboard 已进入 strict TypeScript 门禁。
- 目的：让 WorkItem、Attempt、Artifact、Evidence 和 Acceptance 的核心契约进入 strict 类型检查。
- 范围：workflow、dashboard projection、对应 fixture 和测试类型。
- 不包含：改变领域状态、不变量或事件 schema。
- 依赖：T12.1；与 snapshot import 分支合并后重新核对领域事件。
- 验收标准：canonical event 使用可辨识联合类型；外部 snapshot 仍先运行时校验；全部领域回归通过。
- 验证：类型检查通过；领域与 dashboard 直接测试 25/25、snapshot domain/preview/apply 回归 51/51、全量测试 212/212 通过；两轮独立代码审查无剩余 P0–P3 问题。

## T12.3 — 迁移 application 与 storage

- 状态：已完成；GitHub Issue `#14`，application service、import contract 与 file journal 已进入 strict TypeScript 门禁。
- 目的：类型化 journal、application service、reservation 与恢复边界。
- 范围：application service、file journal、依赖注入接口和测试。
- 不包含：数据库、队列、多进程锁或 schema 变化。
- 依赖：T12.2。
- 验收标准：append/replay/rollback 契约无 `any`；journal 损坏和写失败行为不变。
- 验证：类型检查通过；7 个直接 TypeScript 测试文件 42/42、snapshot/runner/crash 回归 57/57、全量测试 212/212 通过；两轮独立代码审查无剩余 P0–P3 问题。

## T12.4 — 迁移 provider adapters

- 状态：已完成；GitHub Issue `#15`，provider transport、normalizer、inspection 与 dry-run 已进入 strict TypeScript 门禁。
- 目的：类型化 provider 原始事实、显式映射、canonical snapshot 和安全错误。
- 范围：GitHub/Linear normalizer、read client、inspection、dry-run 和测试。
- 不包含：provider 写入、SDK、通用插件市场。
- 依赖：T12.2、T12.3。
- 验收标准：HTTP/GraphQL 响应从 `unknown` 校验；provider 类型不泄漏到领域核心。
- 验证：7 个直接 TypeScript 测试文件 54/54、provider 与 snapshot import 契约回归 74/74、全量测试 229/229 通过；独立审查发现的两项 P2 已按 TDD 修复并复审关闭，最终无剩余 P0–P3。

## T12.7 — 迁移 Snapshot Import

- 状态：已完成；GitHub Issue `#22`，Snapshot Import、fixture 与直接测试已进入 strict TypeScript 门禁。
- 目的：类型化不可信 snapshot 文本到确定性 ImportPlan 的完整 runtime guard、digest、冲突和排序边界。
- 范围：snapshot importer、test-support fixture、preview/domain/apply 直接测试与临时声明清理。
- 不包含：provider 网络、真实外部写入、CLI/server/runner、插件 SDK 或规则变更。
- 依赖：T12.3、T12.4；应在 T12.5/T12.6 完成前独立关闭。
- 验收标准：`JSON.parse` 结果保持 `unknown`；全部资源限制、schema、digest、冲突、排序、apply 和 crash recovery 语义兼容。
- 验证：Snapshot preview/domain/apply 51/51、import batch/journal closure 16/16、扩展定向闭包 71/71、全量测试 229/229 通过；35 个旧/新实现差分场景 0 mismatch；独立审查无剩余 P0–P3。

## T12.5 — 迁移 Codex runner

- 状态：GitHub Issue `#16`，依赖 `#14` 与 `#22`。
- 目的：类型化 JSON-RPC、子进程生命周期、审批拒绝、timeout 和 Attempt 映射。
- 范围：App Server client、runner、fake server 和测试。
- 不包含：更换 Codex SDK、远程 runner、自动审批。
- 依赖：T12.3、T12.7。
- 验收标准：notification/response 使用可辨识类型并保持 fail-closed；真实 read-only smoke 行为不变。
- 验证：runner 定向测试、全量测试和受控 read-only smoke。

## T12.6 — 迁移 CLI 与本地 HTTP server

- 状态：GitHub Issue `#17`，依赖 `#14`、`#15`、`#16` 与 `#22`；后续按 Server/Demo 和 CLI/Bin 两个审查切片交付。
- 目的：完成 Node.js 服务端源码迁移，并类型化命令、请求和关闭生命周期。
- 范围：CLI、server、demo 和对应测试；最后更新 package bin/start。
- 不包含：远程暴露、认证、NestJS 或前端构建。
- 依赖：T12.3、T12.4、T12.5、T12.7。
- 验收标准：CLI shebang/bin 可执行；loopback、CSRF、shutdown 和退出码行为不变。
- 验证：CLI/server 定向测试、全量测试和本地浏览器走查。

## T13 — 重新评估 Control Room 前端工具链

- 状态：等待真实前端复杂度。
- 目的：根据组件、状态、独立部署和复用需求决定继续原生 JS 或引入 TypeScript 构建。
- 范围：决策实验与 ADR。
- 不包含：在没有门槛证据时直接引入框架。
- 依赖：出现独立 Web 发布、复杂组件或共享客户端契约之一。
- 验收标准：方案包含构建、测试、静态资源、部署和回退证据。
- 验证：独立原型与浏览器走查。

## T14 — 重新评估 monorepo 与 NestJS

- 状态：等待 ADR 0002 的升级触发条件。
- 目的：只在独立交付单元或远程平台后端真实出现时引入相应复杂度。
- 范围：边界证据、迁移 ADR、最小原型和成本比较。
- 不包含：把目录数量或未来想象当作拆包依据。
- 依赖：至少一个可观察触发条件。
- 验收标准：monorepo 有独立部署/发布收益；NestJS 有真实横切能力收益；core 保持 framework-free。
- 验证：受限原型、依赖图、构建/测试时间与回退演练。
