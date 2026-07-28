# TaskSeal

> Proof before done.

TaskSeal 是一个 AI Delivery Control Plane 技术验证项目。它把外部任务、Agent 执行、交付物、验证证据和最终验收归一到一条可复核的工作流中。

当前原型已验证两条互补链路：

- fixture 证据链：`Linear → Codex → GitHub → Acceptance`
- 真实运行链：`Local WorkItem → Codex App Server → Attempt terminal state → Control Room`
- provider 只读链：`Provider Observation + Operation Journal → safe projection → Control Room API`

## 项目坐标

- GitHub：`netpilot-z/TaskSeal`
- Linear workspace：`netpilot-z`
- Linear team：`netpilot`
- Linear project：`TaskSeal`

## 原型边界

- 零生产依赖，基于 Node.js 内置能力。
- 服务端代码按切片迁移到 TypeScript；Node.js 原生执行，`tsc --noEmit` 负责类型门禁。
- 当前保持单 package 和 framework-free core；NestJS 与 monorepo 只在出现独立部署或远程平台后端需求时引入。
- 默认不访问真实凭证，不向外部系统写入数据。
- 当前结果用于验证技术和产品假设，不代表生产就绪。
- 内部研发任务以 Linear 为权威来源；GitHub Issue 面向外部 Bug/反馈，GitHub PR/Review/CI 承载代码交付。

## 本地运行

要求 Node.js 24.12 或更高版本。首次检出后安装锁定的开发工具：

```bash
npm ci
npm run typecheck
npm test
node src/cli.ts init
node src/cli.ts doctor
node src/cli.ts run TS-1 --read-only --prompt "Reply with a short status."
node src/cli.ts sync linear --dry-run
npm start
```

`doctor` 会检查项目配置、Codex 可执行文件和登录状态。在 Windows 上，TaskSeal 会比较 PATH 与本机 Codex App 的可用版本并选择较新的版本；也可通过 `TASKSEAL_CODEX_BIN` 显式指定。

启动后访问 `http://127.0.0.1:4317`。Control Room 会读取 `.taskseal/events.jsonl` 的持久交付状态，并可从界面派发一个 Codex Attempt。Provider 面板独立轮询只读的 `GET /api/providers`：它组合 `.taskseal/provider-observations.json` 的配置、scope、snapshot、mapping、缺失证据和诊断状态，以及 `.taskseal/provider-operations.json` 的脱敏 latest 审批、提交、未知结果与对账状态。刷新失败或 source version 回退时保留最后一次已知完整结果并明确标记 stale；三个存储不会互相重放，浏览器没有审批、submit 或 reconcile 写入口。

当前 HTTP 控制面只允许 loopback；远程团队访问需要后续先补认证、TLS、租户权限与审计，不能通过修改 `HOST` 直接暴露。

如只想验证 fixture 证据链，可运行：

```bash
npm test
```

## Provider 只读检查

TaskSeal 可以预览 GitHub、Linear 与 Gitee 的真实只读事实，但不会仅因读取 snapshot 就写入 journal：

```bash
node src/cli.ts inspect github-issue \
  --issue 1 \
  --work-item TS-1 \
  --criterion tests

node src/cli.ts inspect github \
  --issue 1 \
  --pr 1 \
  --check tests \
  --work-item TS-1 \
  --attempt run-1 \
  --criterion tests

node src/cli.ts inspect linear \
  --issue NP-1 \
  --work-item TS-1 \
  --criterion tests

node src/cli.ts inspect gitee-health

node src/cli.ts inspect gitee \
  --issue I4 \
  --work-item TS-GITEE-I4 \
  --criterion review \
  --snapshot-version 2 \
  --title-management none
```

Gitee snapshot 已可进入受控的本地 import application API，但必须同时通过 built-in trusted registry 与精确的 per-scope ImportPolicy v2；当前没有 CLI/HTTP apply route，也不会写回 Gitee。GitHub/Linear 新 apply 还必须显式注入只读 provenance verifier，在 journal commit 前以本次 plan 的精确事件重读并绑定 stable ID、locator、scope、revision、source/event time、实际事件内容与 digest；未注入、无法证明或 Plan v1 没有事件时失败关闭。单次最多验证 8 个 claim，以 4 路并发、15 秒单请求和 30 秒总 deadline 执行。Generic rich/provider-managed `append` 固定拒绝，committed receipt retry 与历史 journal replay 不依赖当前授权、网络或凭证。

GitHub 公开仓库可以匿名读取，也可通过 `GITHUB_TOKEN` 或 `GH_TOKEN` 提供只读 Token。Linear 使用 `LINEAR_API_KEY`，或使用 `LINEAR_ACCESS_TOKEN` 提供 OAuth access token；两者不能同时配置。

Gitee 首版只支持匿名公开仓库，配置为 `config/project.json` 中的非敏感 `gitee.repository` 坐标，不读取或接受 Token。`gitee-health` 验证精确 repository scope；`inspect gitee` 只接受显式、区分大小写的 Issue reference，并固定输出 ProviderSnapshot v2。公共 `oschina/git-osc#I4` 只用于 smoke，不代表 TaskSeal 项目的 Gitee 坐标。

`inspect github-issue` 用于先验证单个 Issue 到 WorkItem 的映射；`inspect github` 用于验证完整 Issue → PR → Check 交付链。两者都要求显式映射，不通过标题或时间猜测关联。成功时只输出裁剪后的 provider scope、source reference 和 canonical events，不输出 Token、原始响应或本地路径，也不修改 `.taskseal/events.jsonl`。实际 CLI 会把最新状态、revision/digest、缺失证据和安全诊断码写入独立 observation 读模型；不会保存标题、URL、raw provider body、凭证或错误正文。

当前 Linear 真实只读链已用 `NP-1` 验证成功：Workspace `netpilot-z`、Team `netpilot (NP)`、Project `TaskSeal`。GitHub 真实链已用获授权的 Issue `#1`、Draft PR `#2` 和 PR head 上成功完成的 `tests` Check 验证：完整 snapshot 生成 `work_item.created`、`artifact.linked` 与 `evidence.recorded`，真实内存重放进入 `reviewing`，且 journal 未变化。

## Linear ticket dry-run

以下命令把仓库 tickets 转为可审查草案：

```bash
node src/cli.ts sync linear --dry-run
```

输出明确标记 `mutationReady: false`、`networkRequests: 0` 和 `externalWrites: 0`。它不会连接 Linear，更不会创建、更新或关闭 Issue。当前已能只读精确解析 Organization、Team、Project 和 Backlog State，并具备未接线的 bounded GraphQL HTTP exchange；Linear 凭证的 Issue 创建、更新和评论权限已由操作者配置，并用 `NP-1` 更新/读后核验确认，但 TaskSeal 真实同步仍需 Operation v2 把 Project/State/source intent 纳入审批与 journal。

默认 dry-run 只读取 `docs/tickets/0006-linear-bootstrap-manifest.md` 中尚未完成且尚未映射的条目；当前 backlog 已完成映射，因此默认结果为 0 张草案，稳定 UUID/identifier 审计见 `docs/tickets/0007-linear-bootstrap-map.json`。内部任务、GitHub Issue 的职责分工、分支命名和迁移规则见 `docs/standards/work-tracking.md`；完整路线见 `docs/tickets/0005-linear-productization-milestone.md`。

## 当前可验证结果

1. 本地 canonical events 被追加到 JSONL journal，重启后可确定性恢复。
2. Codex App Server 完成 `initialize → thread/start → turn/start → turn/completed`。
3. Codex completed 只让 WorkItem 进入 `reviewing`，不会绕过 Artifact、Evidence 和 Owner acceptance。
4. 失败或中断的 Attempt 会保持 `blocked`；晚到的 Artifact/Evidence 只能归档，不能隐式重新开启评审或验收。
5. Control Room 可观察 running/reviewing/blocked、活跃 Agent 和历史 Attempt。
6. GitHub REST 与 Linear GraphQL 只读客户端使用固定契约、精确 scope 和显式映射；mocked-real snapshot 可以内存重放。
7. Linear `NP-1` 与 GitHub Issue `#1` → Draft PR `#2` → `tests` Check 的真实只读 snapshot 均已成功；GitHub 实际 Evidence 为 passed，但没有 Owner acceptance 时仍保持 `reviewing`。
8. Linear ticket dry-run 对当前 manifest 中未完成、未映射的条目确定性生成草案，网络请求与外部写入均为零。
9. TaskSeal runtime 仍没有自动外部 mutation；Linear 已成为内部任务主账本，`NP-1` 与 `NP-2`～`NP-12` 已完成管理性 bootstrap 和读后核验。Issue 创建、更新、评论权限可用，但原生依赖关系接口仍缺少通用 `write` scope；产品内自动提交继续等待 Operation v2。
10. fixture 仍验证 revision-bound Artifact/Evidence 与幂等验收规则。
11. Gitee 内置 AdapterManifest v1、`provider.health` 与 `work-item.read` 已实现，并用公共 `oschina/git-osc#I4` 完成匿名 smoke；本地 preview/apply 只有在 trusted registry 与精确 per-scope policy 同时允许时可用，candidate direct append 固定拒绝，飞书保留为后续异构压力测试。
12. Provider Observation v1 已建立独立、有界、原子替换的 JSON 读模型；按 operation start freshness 拒绝乱序覆盖，通过 observed snapshot-import façade 组合真实 preview/apply，并以 persistent-only `GET /api/providers` 暴露 `configured`、`scope_mismatch`、`sample_missing`、`snapshot_ready` 与 `sync_failed`。
13. Control Room 已具备 Provider 五态卡片、最新 observation 列表、手动刷新、独立轮询、乱序响应防护和 stale 保留视图。
14. 受控 Linear 写已具备 OperationPlan v1、人工审批绑定、严格状态机、client UUID correlation、resolved Team 校验和相邻 snapshot 防篡改合同；任何真实 mutation 仍未接入。
15. Provider Operation Journal v1 已提供独立 `.taskseal/provider-operations.json`、完整 version replay、单实例 CAS、exact-latest idempotency、16 MiB / 512 records 边界、原子替换和崩溃/unknown reopen fence；尚未接 transport、CLI/HTTP 或真实 Linear mutation。首版只适用于可信本地 single writer；Node pathname API 不能消除同权限恶意跨进程 TOCTOU，后置复核只保护 committed/transport 判定，不保证零越界副作用，强保证需要 native `openat/renameat`、SQLite 或独立单写服务。
16. Fake Linear Write Transport v1 已提供 application-owned create/query port、固定 client UUID/Team correlation、128 KiB request 与 64 KiB response guard，以及 created/not-dispatched/outcome-unknown/found/absent/failed/ambiguous 分类；只接受显式注入的内存 fake exchange，没有 global fetch、凭证或真实 Linear 请求。
17. Controlled Write Coordinator v1 已跑通 prepare→approve/reject→submit→reconcile：只有 committed submitting version 能消费一次 fake create permit，并覆盖并发幂等、response-lost UUID 对账、absent 显式重查、journal unknown 零派发和 file-backed restart recovery；仍无 CLI/HTTP 或真实 Linear mutation。
18. Provider status v2 已通过独立 query ports 组合 Observation 与 Operation Journal 的安全 latest projection；Control Room 展示 10 种受控写状态、operation-only target 和 source-local 防回退，任一 source 失败固定 503 并保留浏览器 last-known，且没有新增写 route。
19. Linear Tracker Bootstrap 已显式配置 Project/Backlog State，通过分页只读 resolver 验证 Organization/Team/Project/State 关系，并以固定 endpoint、单凭证、15 秒 timeout、128 KiB request 和 64 KiB streaming response 的真实 HTTP exchange 完成只读 smoke；exchange 尚未注入 v1 写链。

## 项目结构

```text
config/        非敏感项目坐标
docs/          实验、架构和后续接入说明
fixtures/      匿名外部系统夹具
public/        本地 Control Room
src/
  application/ TaskSeal 写入与重放服务
  config/      非敏感项目配置读取与校验
  connectors/  平台事件归一
  dashboard/   只读总览投影
  demo/        可重复演示编排
  domain/      状态与验收不变量
  runners/     Codex App Server transport 与生命周期
  storage/     canonical journal 与独立只读投影存储
test-support/  fake App Server
test/          领域、连接器、集成和 HTTP 测试
```

计划内 Node.js 服务端源码已迁移到 TypeScript；浏览器原生脚本 `public/` 暂不进入 TypeScript 构建。当前 `private: true` 包只支持源码 checkout 运行，尚不把 `bin: src/cli.ts` 视为可安装 npm 发布物。TypeScript、NestJS 与 monorepo 的取舍见 `docs/adr/0002-typescript-repository-strategy.md`，迁移规格见 `docs/specs/0005-typescript-migration.md`。

实验结果见 `docs/experiments/`，Runner 设计见 `docs/architecture/codex-runner.md`，连接器演进方向见 `docs/architecture/connectors.md`，工作跟踪规则见 `docs/standards/work-tracking.md`，当前产品化路线见 `docs/tickets/0005-linear-productization-milestone.md`。现有 Provider 契约见 `docs/research/0001-github-linear-read-contracts.md`，第二 Provider 选择证据见 `docs/research/0002-gitee-feishu-provider-probe.md` 与 `docs/adr/0003-select-gitee-as-second-provider.md`。Provider Observation 的边界与持久化决策见 `docs/specs/0007-provider-observation-read-model.md` 和 `docs/adr/0004-provider-observation-read-model.md`；受控写状态、Operation Journal、fake Linear transport、coordinator、安全 UI 投影、持久化边界、Linear correlation 与 tracker bootstrap 见 `docs/specs/0009-controlled-linear-write-operation.md`、`docs/specs/0010-provider-operation-journal.md`、`docs/specs/0011-fake-linear-write-transport.md`、`docs/specs/0012-controlled-write-coordinator.md`、`docs/specs/0013-provider-operation-projection.md`、`docs/specs/0016-linear-tracker-bootstrap.md`、`docs/adr/0005-controlled-write-operation-journal.md` 和 `docs/research/0003-linear-controlled-write-correlation.md`。
