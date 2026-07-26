# 里程碑 0002：Codex App Server Runner

这些 tickets 是仓库内执行计划，不会自动同步到 Linear。

## T01 — 持久化并恢复 canonical events

- 状态：已完成。
- 目的：让 TaskSeal 状态不再依赖单次进程和固定 demo replay。
- 范围：JSONL journal、损坏检测、单进程串行 append、application service、restart replay。
- 不包含：多进程锁、压缩、数据库、云同步。
- 依赖：规格 0002。
- 实现提示：service 是唯一写入者；先验证候选 workflow，再 append，再提交内存状态。
- 验收标准：重启得到相同 dashboard；重复事件不新增行；冲突和损坏显式失败。
- 验证：`node --test test/event-journal.test.js test/taskseal-service.test.js`。
- 风险与回退：保留 fixture demo 路径；删除本地 journal 即可回到空状态。

## T02 — 提供可诊断的 CLI 生命周期

- 状态：已完成。
- 目的：让使用者通过一个入口初始化、检查并启动本地 TaskSeal。
- 范围：`init`、`doctor`、`start`、参数错误、退出码、被忽略的本地状态目录。
- 不包含：系统服务安装、自启动、远程 daemon 管理。
- 依赖：T01。
- 实现提示：CLI 只调用 application/storage 接口；不得覆盖现有配置或输出凭证。
- 验收标准：init 幂等；doctor 能区分 Codex 不存在和未登录；默认 `npm start` 仍可启动 Control Room。
- 验证：`node --test test/cli.test.js`，并人工执行 `node src/cli.js doctor`。

## T03 — 运行并记录一个 Codex App Server turn

- 状态：已完成；fake 协议测试和真实 read-only turn 均已验证。
- 目的：证明 Codex 可以作为 TaskSeal 的首个真实 runner。
- 范围：stdio JSONL、initialize、thread/start、turn/start、turn/completed、超时、进程退出、Attempt 终态。
- 不包含：PR/Artifact 提取、自动证据、并发池、retry scheduler、Symphony 接入。
- 依赖：T01、T02。
- 实现提示：child process 使用参数数组；cwd 限制在项目根；默认 `workspace-write + never`；清除外部 provider Token。
- 验收标准：fake App Server 覆盖 completed、failed、interrupted、timeout、invalid JSON 和 early exit；真实 read-only smoke 不修改文件。
- 验证：`node --test test/codex-app-server-client.test.js test/codex-runner.test.js`，再运行受控 smoke。
- 风险与回退：App Server 是 experimental；transport 必须可替换，协议失败不影响 journal replay。

## T04 — 在 Control Room 展示持久 Runner 状态

- 状态：已完成；自动化测试覆盖 planned → running → reviewing，浏览器验证 running → reviewing。
- 目的：让操作者看到哪个 Agent 正在运行、最终状态和是否仍缺 Artifact/Evidence。
- 范围：persistent server snapshot、运行入口、轮询、错误提示、现有 demo 兼容。
- 不包含：完整日志流、终端嵌入、审批 UI、多用户协作。
- 依赖：T03。
- 实现提示：HTTP 不直接持有 workflow；UI 不把 completed Attempt 展示为 accepted。
- 验收标准：浏览器可观察 planned → running → reviewing/blocked；没有证据时 Acceptance pending；控制台无错误。
- 验证：server 集成测试与浏览器走查。

## T05.1 — 实现 GitHub 只读交付 snapshot

- 状态：实现与自动化契约已完成；真实 Issue-only snapshot 已成功，完整交付样本仍缺关联 PR/Check。
- 目的：验证真实 GitHub Issue、PR 与 Check Run payload 可以生成 revision-bound canonical events。
- 范围：固定 REST 版本、匿名或环境 Token、显式 Issue/PR/Check 映射、head SHA、同源分页和安全错误。
- 不包含：自动发现 linked PR、创建或更新 Issue、评论、关闭、merge。
- 依赖：T04、规格 0003。
- 验收标准：fake REST contract 可生成 `work_item.created`、`artifact.linked` 与 `evidence.recorded`，并拒绝歧义或 revision 不一致。
- 验证：GitHub normalizer、read client 与 provider inspection 测试；真实公开仓库 read-only smoke。
- 风险与回退：完整 PR/Check 样本缺失时返回明确诊断，Issue-only 与 fixture 模式继续可用。

## T05.2 — 实现 Linear 只读 Issue snapshot

- 状态：已完成；自动化契约与真实 `NP-1` 只读 snapshot 均已验证。
- 目的：验证真实 Linear Organization/Team/Issue payload 可以生成 WorkItem canonical event。
- 范围：API key/OAuth 区分、scope 分页、精确 workspace/team 校验、Issue team 校验和安全错误。
- 不包含：创建、更新、评论、关闭或移动 Linear Issue。
- 依赖：T04、规格 0003。
- 验收标准：fake GraphQL contract 可生成 `work_item.created`；HTTP 200 中的 GraphQL errors 和 scope 漂移都失败关闭。
- 验证：Linear normalizer、read client 与 provider inspection 测试；真实 read-only scope smoke。
- 风险与回退：配置与凭证 scope 不一致时返回明确诊断；真实坐标由操作者确认后才更新配置。

## T05.3 — 提供 provider inspect CLI 与契约重放

- 状态：已完成；mocked-real snapshot 可重放，Linear 与 GitHub Issue-only 真实 snapshot 成功，完整 GitHub 样本缺失可稳定诊断。
- 目的：让操作者在写入 journal 前审查 provider scope、显式映射和 canonical events。
- 范围：`inspect github-issue`、`inspect github`、`inspect linear`、JSON snapshot、退出码、错误裁剪和 mocked-real 内存重放。
- 不包含：snapshot import、缓存、后台轮询或 Control Room provider 面板。
- 依赖：T05.1、T05.2。
- 验收标准：参数完整时输出无凭证、无绝对路径的 snapshot；参数或 provider 失败有稳定退出码；snapshot 不修改 journal。
- 验证：CLI 测试、完整 in-memory replay、真实只读诊断。
- 风险与回退：inspect 与现有 init/start/run 完全解耦，失败不影响 Runner。

## T06 — 预览但不执行 Linear tickets 同步

- 状态：已完成 dry-run；当前没有向 Linear 创建或更新 Issue。
- 目的：让使用者看到将写入 Linear 的 Issue 内容和数量，再决定是否授权。
- 范围：把本文件 tickets 映射为 Linear Issue draft，输出确定性 dry-run。
- 不包含：调用 Linear endpoint、生成或发送 mutation、创建、修改或关闭 Issue。
- 依赖：T05.3、规格 0003。
- 验收标准：dry-run 明确 workspace、team、标题、描述、ticket 依赖、非 ticket 前置条件、草案幂等键和 payload digest，并报告零网络与零外部写入。
- 验证：解析、确定性、路径边界和 CLI 测试；实际写入需要新的明确授权。
