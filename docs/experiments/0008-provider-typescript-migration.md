# 实验 0008：Provider TypeScript 迁移

## 实验卡

- 决策：能否在不改变 GitHub/Linear 只读行为、ProviderSnapshot v2、inspection v1/v2 和 Linear dry-run 零写入语义的前提下，把 provider 边界迁移到 strict TypeScript。
- 假设：transport JSON 保持 `unknown`，由 provider-local runtime guard 逐层收窄；共享模块只拥有归一化 snapshot/fact，不需要 BaseAdapter、通用 GraphQL client 或写能力抽象。
- 反证：必须使用 `any`、断言或类型忽略；合法 provider 生命周期被误判；畸形响应进入 canonical fact；凭证、raw payload 或 provider DTO 泄漏到领域层。
- 指标：类型检查、provider 定向测试和全量测试通过；迁移前可观察错误语义兼容；独立审查无剩余 P0–P3；不产生 JavaScript。
- 边界：迁移 GitHub/Linear normalizer、read client、provider snapshot、inspection、Linear dry-run 与直接测试；未迁移的 CLI、demo 和 snapshot importer 只更新显式 import。

## Red

首次机械改名曾把约千行 snapshot importer 一并纳入，类型检查产生约 727 行诊断，无法形成小而可审查的 provider 切片。因此创建 GitHub Issue `#22`（T12.7）单独迁移 Snapshot Import，并把本实验恢复为 Issue `#15` 的原始范围。

收缩后 provider 闭包仍有 124 条严格类型诊断，集中在 inspection、dry-run、nullable provider 状态、GraphQL envelope 和测试接缝。它们作为逐模块迁移的红灯基线，没有通过断言或降低 `tsconfig` 要求绕过。

## Green

- `provider-snapshot.ts` 只拥有 GitHub/Linear 已归一化的 source object、revision、observation、fact 与 v2 snapshot 类型；transport DTO 留在各 connector。
- GitHub REST 与 Linear GraphQL 的 `json()` 结果显式为 `unknown`，逐层验证 response、envelope、connection、pageInfo、organization、team、issue、PR 和 Check。
- GitHub 请求保持 GET、固定 API origin/version；分页限制为同源、最多十页并拒绝重复 URL。
- Linear 只允许模块内固定 read query；即使 HTTP 200，只要 GraphQL `errors` 非空即失败，畸形 `errors` 成员也失败关闭。
- GitHub Check 使用生命周期 DTO：未完成态允许 nullable `conclusion/completed_at` 并返回稳定的 `GITHUB_CHECK_INCOMPLETE`；完成态必须收窄为非空标量。
- inspection 用精确 overload 区分 v1 display snapshot 与 v2 importable snapshot；凭证只流向 read-client 请求头，输出保持脱敏。
- Linear dry-run 建立显式 ticket/draft/plan 类型，继续固定 `mutationReady: false`、`networkRequests: 0`、`externalWrites: 0`。
- Snapshot Import 实现仍为 JavaScript，只通过显式 `.ts` import 消费本次迁移结果。

## 审查驱动修复

独立审查发现并复现两项 P2：

1. 合法 `in_progress` GitHub Check 的 `completed_at: null` 被过早判为无效响应；
2. Linear 的畸形非数组 `errors` 可能与有效 `data` 一起被接受。

两项均先补失败回归，再修改生产代码。修复后原复现场景分别稳定返回 `GITHUB_CHECK_INCOMPLETE` 与 `LINEAR_RESPONSE_INVALID`；两轮复审确认问题关闭且无新增 P0–P3。

## 验证证据

- `npm run typecheck`：通过。
- 7 个直接 TypeScript 测试文件：54/54 通过。
- Provider 与 snapshot import 契约定向回归：74/74 通过。
- `npm test`：229/229 通过，0 skipped。
- `git diff --check`：通过；仅有 Windows working-copy 的 LF/CRLF 提示。
- 架构、backend 与 verification 三个独立只读 pass 完成；最终无剩余 P0–P3。
- 未发现 `any`、类型忽略、类型断言、旧目标 `.js` import、本地绝对路径、凭证或生成 JavaScript。

## 结论

支持假设。Provider transport、normalizer、inspection 和 dry-run 已进入 strict TypeScript；不可信 REST/GraphQL 数据仍通过运行时校验，read/write capability 保持分离，ProviderSnapshot v2 与领域核心没有吸收 provider 原始类型。
