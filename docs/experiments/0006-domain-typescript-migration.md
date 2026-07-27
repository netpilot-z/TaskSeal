# 实验 0006：领域与 Dashboard TypeScript 迁移

## 实验卡

- 决策：能否在不改变事件 schema、领域不变量和 Dashboard 输出的前提下，把核心工作流迁移到 strict TypeScript。
- 假设：`unknown → runtime guard → CanonicalEvent → typed handler` 可以同时保留不可信输入校验，并为九类 canonical event 建立可穷尽的编译期联合。
- 反证：迁移要求类型断言或 `any`；旧 snapshot 无法重放；错误码、错误优先级、领域状态或 Dashboard 投影发生变化。
- 指标：类型检查通过；定向和全量测试无回退；独立差分审查未发现行为漂移；不产生 JavaScript。
- 边界：只迁移 domain workflow、Dashboard projection 及直接测试；application、storage、provider、runner、CLI 和 server 留在后续切片。

## Red

文件改为 `.ts` 并更新 import 后，首次 `npm run typecheck` 失败，暴露了隐式参数类型、`unknown` 输入、nullable 字段、数组索引和 reducer overload 等真实类型缺口。

## Green

- `Workflow`、`WorkItem`、`Attempt`、`Artifact`、`Evidence`、`AcceptanceDecision` 与 `ExternalLink` 由领域模块拥有并导出。
- 九种 canonical event 组成以 `type` 为判别字段的联合，并由运行时 validator 收窄后直接驱动穷尽分发。
- `applyEvent` 继续接受 `unknown`；envelope、payload、幂等冲突和领域不变量仍在运行时校验。
- Dashboard 只通过 `import type` 依赖领域状态，并拥有自己的 summary 与 work-item projection 类型。
- Legacy/Rich ExternalLink 兼容路径、Acceptance 特殊错误顺序和既有输出结构保持不变。

## 验证证据

- `npm run typecheck`：通过。
- 领域与 Dashboard 直接测试：25/25 通过。
- Snapshot domain/preview/apply 回归：51/51 通过。
- `npm test`：212/212 通过，0 skipped。
- 独立审查对 876 组合法事件字段变异执行迁移前后差分，错误码、消息和状态结果零差异。
- `git diff HEAD --check`：通过；仅有 Windows working-copy 的 LF/CRLF 提示。
- 未发现 `any`、类型忽略、宽泛双重断言、旧运行时 import、本地绝对路径、凭证或生成 JavaScript。

## 结论

支持假设。领域边界已经进入 strict TypeScript，同时保留不可信输入的运行时防线。下一切片可以直接复用 `Workflow` 与 `CanonicalEvent` 契约迁移 application 和 storage。
