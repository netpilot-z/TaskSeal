# TaskSeal

> Proof before done.

TaskSeal 是一个 AI Delivery Control Plane 技术验证项目。它把外部任务、Agent 执行、交付物、验证证据和最终验收归一到一条可复核的工作流中。

当前原型已验证两条互补链路：

- fixture 证据链：`Linear → Codex → GitHub → Acceptance`
- 真实运行链：`Local WorkItem → Managed Runner Host → Codex App Server Adapter → Attempt terminal state → Control Room`
- 分解协作链：`Root WorkItem → human-approved DAG → explicit Runner dispatch → node Evidence/Acceptance → retirement audit`
- provider 只读链：`Provider Observation + Operation Journal → safe projection → Control Room API`
- 人工验收写链：`current Attempt/Artifact/Evidence → human AcceptanceDecision → Transition Operation v3 → exact Linear Done readback`

完整操作顺序与失败恢复见 [项目范围 Dogfood 操作手册](docs/operations/0001-project-scoped-dogfood.md)。

## 项目坐标

- GitHub：`netpilot-z/TaskSeal`
- Linear workspace：`netpilot-z`
- Linear team：`netpilot`
- Linear project：`TaskSeal`

## 原型边界

- 零生产依赖，基于 Node.js 内置能力。
- 服务端源码使用 TypeScript；源码 checkout 由 Node.js 原生执行，安装包由 `tsc` 预编译为 JavaScript。
- 当前保持单 package 和 framework-free core；NestJS 与 monorepo 只在出现独立部署或远程平台后端需求时引入。
- 默认不访问真实凭证，不向外部系统写入数据。
- 当前结果用于验证技术和产品假设，不代表生产就绪。
- 内部研发任务以 Linear 为权威来源；GitHub Issue 面向外部 Bug/反馈，GitHub PR/Review/CI 承载代码交付。

## 本地运行

要求 Node.js `>=24.12.0 <25`。首次检出后安装锁定的开发工具：

```bash
npm ci
npm run typecheck
npm test
node src/cli.ts init
node src/cli.ts doctor
node src/cli.ts run TS-1 --read-only --prompt "Reply with a short status."
node src/cli.ts ready linear
node src/cli.ts sync linear --dry-run
npm start
```

`doctor` 会检查项目配置、Codex 可执行文件和登录状态。在 Windows 上，TaskSeal 会比较 PATH 与本机 Codex App 的可用版本并选择较新的版本；也可通过 `TASKSEAL_CODEX_BIN` 显式指定。

启动后访问 `http://127.0.0.1:4317`。Control Room 会读取 `.taskseal/events.jsonl` 的持久交付状态，可选择具体 WorkItem 派发、取消或人工重试 Attempt，并展示 owner、当前运行与历史 Attempt。当前内置数字员工是 Codex App Server Adapter；Attempt 生命周期由通用 Managed Runner Host 统一管理。并发默认 `1`，可用 `TASKSEAL_MAX_CONCURRENT_RUNS=2`～`8` 显式增加；达到容量会拒绝而不会建立隐式队列。已批准的分解计划保存在独立的 `.taskseal/decomposition-plans.json`，Control Room 只显示 `accepted nodes / total nodes`、真实依赖、owner、Evidence、重试和 Attempt trace，不估算完成百分比。DAG 使用显式 dispatch tick，ready queue 不持久；静默计划可由本机操作者不可逆退役，释放编排 ownership，但 WorkItem 与全部交付历史会保留在审计中。Provider 面板独立轮询只读的 `GET /api/providers`：它组合 `.taskseal/provider-observations.json` 的配置、scope、snapshot、mapping、缺失证据和诊断状态，以及 `.taskseal/provider-operations.json` 的脱敏 latest 审批、提交、未知结果与对账状态。刷新失败或 source version 回退时保留最后一次已知完整结果并明确标记 stale；各存储不会互相重放。浏览器只开放 DAG 显式派发/退役、WorkItem 人工 accept/reject 与未知 Linear transition 的显式 reconcile，不开放任意 Provider create/update 控制台。

当前 HTTP 控制面只允许 loopback；远程团队访问需要后续先补认证、TLS、租户权限与审计，不能通过修改 `HOST` 直接暴露。
本地人工验收还需要设置稳定的非敏感操作者 ID，例如 `TASKSEAL_HUMAN_ACTOR=operator.jeffrey`。该值不会由浏览器提交，也不会传入 Codex Runner。它只代表可信本机边界内的 accountable identity，不等同于远程认证。

如只想验证 fixture 证据链，可运行：

```bash
npm test
```

## 安装包与插件开发包

当前 package 仍为 `private` 技术验证版，不发布到 npm registry；但可以从当前提交生成并在仓库外安装本地 tarball：

```bash
npm pack
npm install ../taskseal-0.0.0-experiment.3.tgz
npm exec -- taskseal --help
npm exec -- taskseal --version
```

安装包中的 CLI 只执行 `dist/` JavaScript，不依赖 TypeScript runtime。公开 API 使用显式版本子路径：

```js
import {
  parseRunnerManifest
} from "taskseal/runner/v1";
import {
  normalizeProviderAdapterV1
} from "taskseal/provider/v1";
import {
  parseTaskSealPluginManifest
} from "taskseal/plugin/v1";
```

Runner 与只读 Provider 的 contract kit 分别位于 `taskseal/testing/runner/v1` 和 `taskseal/testing/provider/v1`；配置 schema 位于 `taskseal/schemas/project-config` 与 `taskseal/schemas/plugin-manifest`。`examples/` 提供可直接运行合同测试的 Echo Runner 和内存 Provider。

```bash
npm exec -- taskseal plugin check ./taskseal.plugin.json
```

该命令只读取不超过 64 KiB 的 JSON 并检查 API、合同、Node 版本和安全相对入口，不会加载、安装或执行插件。首版 SDK 是受信开发者的 authoring contract；第三方插件发现、动态加载与进程隔离仍不在当前范围。

## Provider 只读检查

TaskSeal 可以预览 GitHub、Linear、Gitee 与飞书多维表格的真实只读事实，但不会仅因读取 snapshot 就写入 journal：

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

node src/cli.ts inspect feishu-health

node src/cli.ts inspect feishu \
  --work-item NP-18 \
  --criterion tests \
  --snapshot-version 2 \
  --title-management none
```

Gitee snapshot 已可进入受控的本地 import application API，但必须同时通过 built-in trusted registry 与精确的 per-scope ImportPolicy v2；当前没有 CLI/HTTP apply route，也不会写回 Gitee。GitHub/Linear 新 apply 还必须显式注入只读 provenance verifier，在 journal commit 前以本次 plan 的精确事件重读并绑定 stable ID、locator、scope、revision、source/event time、实际事件内容与 digest；未注入、无法证明或 Plan v1 没有事件时失败关闭。单次最多验证 8 个 claim，以 4 路并发、15 秒单请求和 30 秒总 deadline 执行。Generic rich/provider-managed `append` 固定拒绝，committed receipt retry 与历史 journal replay 不依赖当前授权、网络或凭证。

GitHub 公开仓库可以匿名读取，也可通过 `GITHUB_TOKEN` 或 `GH_TOKEN` 提供只读 Token。Linear 使用 `LINEAR_API_KEY`，或使用 `LINEAR_ACCESS_TOKEN` 提供 OAuth access token；两者不能同时配置。

Gitee 首版只支持匿名公开仓库，配置为 `config/project.json` 中的非敏感 `gitee.repository` 坐标，不读取或接受 Token。`gitee-health` 验证精确 repository scope；`inspect gitee` 只接受显式、区分大小写的 Issue reference，并固定输出 ProviderSnapshot v2。公共 `oschina/git-osc#I4` 只用于 smoke，不代表 TaskSeal 项目的 Gitee 坐标。

飞书首版只支持企业自建应用读取一个固定测试 Base。App ID/Secret、Base/table/record 坐标和三个字段名仅从 `TASKSEAL_FEISHU_*` 环境变量解析；仓库配置只保存不可逆的 table scope digest，用来发现环境漂移。CLI 不接受调用者指定 Base、table 或 record，输出也只包含 opaque scope/object digest。`records/search` 的 POST 固定为空查询 body，只承担 2+1 有界分页，不具有写语义。飞书当前没有 trusted ingress registration、ImportPolicy 或 apply route，因此 snapshot 只进入 observation 与可视化，不会创建本地 WorkItem，也不会写回飞书。

`inspect github-issue` 用于先验证单个 Issue 到 WorkItem 的映射；`inspect github` 用于验证完整 Issue → PR → Check 交付链。两者都要求显式映射，不通过标题或时间猜测关联。成功时只输出裁剪后的 provider scope、source reference 和 canonical events，不输出 Token、原始响应或本地路径，也不修改 `.taskseal/events.jsonl`。实际 CLI 会把最新状态、revision/digest、缺失证据和安全诊断码写入独立 observation 读模型；不会保存标题、URL、raw provider body、凭证或错误正文。

当前 Linear 真实只读链已用 `NP-1` 验证成功：Workspace `netpilot-z`、Team `netpilot (NP)`、Project `TaskSeal`。GitHub 真实链已用获授权的 Issue `#1`、Draft PR `#2` 和 PR head 上成功完成的 `tests` Check 验证：完整 snapshot 生成 `work_item.created`、`artifact.linked` 与 `evidence.recorded`，真实内存重放进入 `reviewing`，且 journal 未变化。

## GitHub delivery reconciliation

`github.delivery` 把项目 repository 与一个仓库相对 mapping index 绑定。当前 `config/github-delivery-map.json` 是安全的空 bootstrap；明确 PR、head branch、reviewer numeric ID 和 Check selector 后，再按 `docs/specs/0020-github-delivery-evidence.md` 增加条目。空 index 不扫描分支，也不按标题猜测。

对已存在且具有 active Attempt 的 WorkItem，先只读预览：

```bash
node src/cli.ts reconcile github \
  --mode preview \
  --work-item <local-work-item-id>
```

人工审阅输出的 plan 后，用同一 WorkItem 与 digest 应用：

```bash
node src/cli.ts reconcile github \
  --mode apply \
  --work-item <local-work-item-id> \
  --expected-plan-digest <sha256>
```

runtime 会在网络前核对 mapping 中的 Linear UUID 与 WorkItem rich link、required evidence 和 active Attempt；随后精确读取 PR number、fork-aware head repository/branch、当前 head checks 和 reviewer-specific decisive reviews，并在采集后再次读取 PR 防止 revision race。新 head 即使 Evidence 尚未齐全也会先计划 Artifact，使旧 Evidence 不再满足当前验收；重复 facts 返回 `up_to_date`。apply 会重新采集 reviewed plan，把 Check name/app 与 Review reviewer selector 同时绑定到 snapshot，并回读 exact PR/check/review provenance，只写本地 atomic journal。已提交 digest 的重试会先从当前 index/journal 验证 mapping 与 active head：精确匹配时即使功能关闭或无凭证也零网络返回 receipt，旧 head 或 mapping 漂移则 stale。输出始终为 `githubWrites: 0`、`linearWrites: 0`。

## Linear ready work

以下命令只读列出配置 Project/Team 中精确处于 Todo 的 Issue：

```bash
node src/cli.ts ready linear
```

选择必须使用 Linear UUID，不能使用标题或模糊匹配。先预览本地 ImportPlan，再用完全相同的参数和 reviewed digest 应用：

```bash
node src/cli.ts ready linear \
  --mode preview \
  --issue <linear-issue-uuid> \
  --work-item <local-work-item-id> \
  --criterion tests

node src/cli.ts ready linear \
  --mode apply \
  --issue <linear-issue-uuid> \
  --work-item <local-work-item-id> \
  --criterion tests \
  --expected-plan-digest <sha256>
```

list/preview 不写 journal，其中 list 不打开本地 journal；apply 只通过既有 Snapshot Import 创建或关联本地 WorkItem，仍为 `linearWrites: 0`。新 apply 会重新验证 Organization、Team、Project、Todo、原生 blocker、声明依赖和依赖的实时 Done 状态；blocked/unknown 均失败关闭。历史 bootstrap map 的 Organization/Team/Project UUID 必须与 resolved scope 精确一致；它只补充已覆盖 Issue 的关系拓扑，不限制新 Issue，正确 scope 中的未覆盖项由完整 native relation 判定。重复 apply 会先离线恢复 reviewed digest 对应的 committed batch context，并同时绑定 Linear source、WorkItem 和 mapping；精确命中时不读取配置、凭证或网络。`linear.readyWork.enabled: false` 时新入口零网络，既有 receipt replay 与本地 `taskseal run <work-item-id>` 保持可用。

## 人工验收与 Linear Done

Control Room 为当前 WorkItem 展示服务端计算的 `acceptanceReviewRevision`。浏览器提交 `decisionId / decision / reason / expectedReviewRevision`，操作者 ID 只由服务端的 `TASKSEAL_HUMAN_ACTOR` 注入。Accept 仍必须同时满足：当前 Attempt 成功完成、当前 Artifact 存在、每项 Required Evidence 的当前 revision 最新结果均通过；Reject 只保存本地原因与历史，不访问 Linear。已 accepted 的 WorkItem 不能通过普通 Retry 隐式重开。

`linear.acceptance` 缺失或 `{ "enabled": false }` 时，本地 accept/reject 仍可用，但不读取 Linear 凭证、不构造 exchange、网络请求为零。启用真实迁移时必须显式配置独立于 ready-work 的来源和目标状态：

```json
{
  "linear": {
    "acceptance": {
      "enabled": true,
      "expectedState": "In Progress",
      "targetState": "Done"
    }
  }
}
```

启用后，TaskSeal 先提交本地 Acceptance，再为同一 rich Linear UUID 创建 Transition Operation v3、由同一服务端操作者批准、提交 committed `submitting` permit，mutation 只发送目标 `stateId`，随后独立按 UUID 读回。Linear 没有 revision 条件 mutation，因此写前 `updatedAt` 只能作为 stale fence，不能宣称远端原子 CAS。响应丢失或重启恢复为 `outcome_unknown`，只能从页面显式 reconcile；浏览器不提供 plan digest，服务端从持久 operation 取回后再查询，绝不盲目重发 mutation。本地 Accepted 与 Linear Done 始终分开显示。

## Linear ticket dry-run

以下命令把仓库 tickets 转为可审查草案：

```bash
node src/cli.ts sync linear --dry-run
```

输出明确标记 `mutationReady: false`、`networkRequests: 0` 和 `externalWrites: 0`。它不会连接 Linear，更不会创建、更新或关闭 Issue。当前已能只读精确解析 Organization、Team、Project 和 Backlog State；Linear 凭证的 Issue 创建、更新和评论权限已由操作者配置，并用 `NP-1` 更新/读后核验确认。Issue Create Operation v2 仍没有真实提交入口；只有 Acceptance 专用的 Transition Operation v3 通过显式开关接入 bounded GraphQL exchange。

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
9. TaskSeal runtime 只有人工 Acceptance 后的 Linear State transition 能进行真实外部 mutation；任意 Issue Create、评论、删除或自动关闭仍未开放。Linear 已成为内部任务主账本，`NP-1` 与 `NP-2`～`NP-12` 已完成管理性 bootstrap 和读后核验。
10. fixture 仍验证 revision-bound Artifact/Evidence 与幂等验收规则。
11. Gitee 内置 AdapterManifest v1、`provider.health` 与 `work-item.read` 已实现，并用公共 `oschina/git-osc#I4` 完成匿名 smoke；本地 preview/apply 只有在 trusted registry 与精确 per-scope policy 同时允许时可用，candidate direct append 固定拒绝。飞书也已完成同一 AdapterManifest 的异构只读验证，真实 Base 只暴露不透明 table/record digest，并明确不注册 import。
12. Provider Observation v1 已建立独立、有界、原子替换的 JSON 读模型；按 operation start freshness 拒绝乱序覆盖，通过 observed snapshot-import façade 组合真实 preview/apply，并以 persistent-only `GET /api/providers` 暴露 `configured`、`scope_mismatch`、`sample_missing`、`snapshot_ready` 与 `sync_failed`。
13. Control Room 已具备 Provider 五态卡片、最新 observation 列表、手动刷新、独立轮询、乱序响应防护和 stale 保留视图。
14. 受控 Linear 写已具备 OperationPlan v1/v2 union reader；v2 把 configured Project/State、resolved Organization/Team/Project/State/Parent、source intent、payload 和审批摘要绑定在同一 plan，并保持 v1 persisted golden bytes 与摘要不变。
15. Provider Operation Journal v1 envelope 已可重放不同 operation 的 v1/v2 history，拒绝同一 client UUID 跨版本迁移，并提供完整 version replay、单实例 CAS、exact-latest idempotency、16 MiB / 512 records 边界、原子替换和崩溃/unknown reopen fence。首条 v2 record 落盘后只能回滚到具备 union reader 的版本；可信本地 single writer 与 pathname TOCTOU 边界不变。
16. Fake Linear Write Transport 保留 v1 exact port，并新增独立 project-aware v2 create/query port：固定 client UUID，显式发送 Team/Project/State/Parent，观察 Organization/Team/Project/State/Parent，完整区分 created/not-dispatched/outcome-unknown/found/absent/failed/ambiguous；只接受注入 exchange，没有 global fetch、凭证 fallback 或真实 Linear composition。
17. Controlled Write Coordinator 已跑通 v1 与 v2 prepare→approve/reject→submit→reconcile：只有 committed submitting version 能消费一次 fake create permit；缺失 v2 port、begin append 未 committed、拒绝和非法状态均为零调用，并覆盖并发幂等、response-lost UUID/placement 对账和 reopen recovery。source intent 不出站，仍无 CLI/HTTP 或真实 Linear mutation。
18. Provider status v2 已通过独立 query ports 组合 Observation 与 Operation Journal 的安全 latest projection；Create projection v1 保持不变，Transition projection v2 只公开 WorkItem/decision correlation 与脱敏状态。Control Room 以 exact decision ID 关联当前验收，任一 source 失败固定 503 并保留浏览器 last-known。
19. Linear Tracker Bootstrap 已显式配置 Project/Backlog State，通过分页只读 resolver 验证 Organization/Team/Project/State 关系，并以固定 endpoint、单凭证、15 秒 timeout、128 KiB request 和 64 KiB streaming response 的真实 HTTP exchange 完成只读 smoke；该 exchange 仅在 Acceptance transition 显式启用且 actor/凭证有效时注入真实 `issueUpdate(stateId)` 写链。
20. Linear Ready Work 已显式配置 Todo/Done、50×20 有界 Issue 分页、客户端 scope 对账、native/declared blocker union 与实时 Done 门禁；bootstrap map target 必须绑定 resolved Organization/Team/Project，正确 scope 中未覆盖的新 Issue 由完整 native relation 判定。CLI 只接受 UUID 单票，提供 list→preview→apply，list 不读取 journal，本地 create/link 复用 Snapshot Import、provenance、atomic batch 和离线 receipt replay；依赖索引拒绝 ADS/路径逃逸并有 512 KiB 上限，真实 smoke 为 0 候选且 journal hash 不变。
21. Control Room 已由 application-owned coordinator 提供任务选择、单项 cancel、默认 1/最大 8 的有界并发和安全容量投影；选择不会被轮询重置，有可用槽位时无关任务可并行，取消在 Attempt terminal 写完前保持 `cancelling`，人工 retry 生成新 Attempt 并保留旧历史。
22. GitHub DeliveryMapping 已把 Linear UUID、WorkItem、target PR、fork-aware head branch 与最多七项 Check/Review criteria/selector identity 显式绑定；CLI 提供 read-only preview 与 local atomic apply，head fence、missing Evidence、重复对账、exact provenance、selector tamper、旧/当前 head receipt replay 和 disabled/foreign-target 零网络均有自动化验证，且没有 GitHub/Linear mutation。Review batch 使用 PolicyBinding v3；首条 v3 record 落盘后只能回退到具备 v3 union reader 的版本。
23. Acceptance Decision v2 绑定 current Attempt/Artifact/review revision 并保留历史；Transition Operation v3 绑定同一 Linear UUID、Organization/Team/Project、expected state/revision、target state 与 acceptance digest。Control Room 已接入 server-owned actor、exact body/CSRF、local-vs-Linear 双事实、响应丢失 reconcile 和 accepted 后普通 Retry 门禁；功能关闭时凭证字段读取与网络请求均为零。
24. Runner Contract v1 已建立 capability manifest、独立且默认只读的 Host policy、
    冻结 input、严格 output decoder、application-owned Attempt Host、
    deadline/cancel 后的 bounded cleanup 与 Host fence、bounded untrusted handoff
    claim 和显式子进程环境 allowlist；Codex Adapter 与第二个 deterministic fake
    Runner 通过同一 contract kit，Domain/journal 无需为第二种 Runner 修改。
25. Decomposition Plan v1 已建立有界 DAG preview/approve、Runner profile revision
    绑定、显式容量派发、plan-scoped dependency/acceptance 双门禁、accepted-node
    真实进度和 Control Room 协作视图。approval record v2 为 root/node 原子保存
    Attempt baseline，envelope v3 明确 reader fence；同一 lifecycle dispatcher
    线性化 approval/run、acceptance/retirement 与 retirement/dispatch。新计划从新
    generation 接管 WorkItem，不继承旧 retry/rejection/owner/Evidence；退役仍保留
    全部 WorkItem、Attempt、Artifact、Evidence 和验收历史。
26. 本地 tarball 已使用 `tsc → dist` 提供可安装 CLI、版本化 Runner/Provider/
    Plugin facade、公开 contract kit、schema 与示例；pack/install 门禁验证
    Windows npm bin、仓库外 JavaScript/TypeScript consumer、内部 export fence、
    Node 版本 fail-fast 和发布物路径/凭证扫描。`plugin check` 只做 64 KiB 有界
    静态 JSON 兼容检查，不加载 entrypoint；package 继续保持 private、单包、
    零生产依赖和零 hosted service 要求。

## 项目结构

```text
config/        非敏感项目坐标
docs/          实验、架构和后续接入说明
fixtures/      匿名外部系统夹具
public/        本地 Control Room
examples/      Runner/Provider SDK 示例与合同测试
schemas/       可发布的项目配置与插件清单 schema
src/
  application/ TaskSeal 写入、重放与 Managed Runner Host
  config/      非敏感项目配置读取与校验
  connectors/  平台事件归一
  dashboard/   只读总览投影
  demo/        可重复演示编排
  domain/      状态与验收不变量
  runners/     Runner v1 合同、Codex Adapter 与 App Server transport
  sdk/         版本化公开 facade 与 contract kit
  storage/     canonical journal 与独立只读投影存储
test-support/  fake App Server、fake Runner 与 contract kit
test/          领域、连接器、集成和 HTTP 测试
```

计划内 Node.js 服务端源码已迁移到 TypeScript；浏览器原生脚本 `public/` 暂不进入 TypeScript 构建。当前 `private: true` 包同时保留源码 checkout 入口和指向 `dist/bin/taskseal.js` 的可安装本地 tarball；`files` 与 `exports` 双 allowlist 限制发布内容和公共 API。它不是 registry 发布版，也不动态执行第三方插件。TypeScript、NestJS 与 monorepo 的基础取舍见 `docs/adr/0002-typescript-repository-strategy.md`，本次发布边界见 `docs/specs/0024-installable-cli-plugin-sdk.md` 与 `docs/adr/0015-single-package-compiled-cli-plugin-sdk.md`。

实验结果见 `docs/experiments/`，Runner 设计见 `docs/architecture/codex-runner.md`、`docs/specs/0022-stable-runner-contract.md` 与 `docs/adr/0013-application-owned-runner-host.md`；DAG 分解与协作控制见 `docs/specs/0023-decomposition-dag-observability.md` 与 `docs/adr/0014-independent-approved-decomposition-lifecycle.md`。连接器演进方向见 `docs/architecture/connectors.md`，工作跟踪规则见 `docs/standards/work-tracking.md`，当前产品化路线见 `docs/tickets/0005-linear-productization-milestone.md`，首个真实项目 Dogfood 见 `docs/pilots/0001-scope-ledger-single-owner.md`。现有 Provider 契约见 `docs/research/0001-github-linear-read-contracts.md`，第二 Provider 选择证据见 `docs/research/0002-gitee-feishu-provider-probe.md` 与 `docs/adr/0003-select-gitee-as-second-provider.md`，飞书只读资源访问路径见 `docs/research/0005-feishu-readonly-resource-access.md`。Provider Observation 的边界与持久化决策见 `docs/specs/0007-provider-observation-read-model.md` 和 `docs/adr/0004-provider-observation-read-model.md`；人工验收与 Linear Done 见 `docs/specs/0021-human-acceptance-linear-transition.md`、`docs/adr/0012-linear-acceptance-transition-operation.md` 与 `docs/research/0004-linear-issue-transition-cas.md`。
