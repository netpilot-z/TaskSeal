# 实验 0010：Codex Runner TypeScript 迁移

## 实验卡

- 决策：能否在不更换 Codex App Server transport、不放宽审批、cwd 或凭证边界的前提下，把 connector、JSON-RPC client、runner 和 fake server 迁移到 strict TypeScript。
- 假设：stdio JSONL 始终先作为 `unknown` 解码；method-specific result 与 terminal notification 分别校验；runner 只依赖窄 service/client port 即可保持 Attempt 语义。
- 反证：必须使用 `any`、断言或类型忽略；畸形协议进入已知类型；approval 被接受；外部路径、凭证或不可信错误正文进入持久化证据；timeout、abort 或 shutdown 行为回归。
- 指标：类型检查、直接与间接测试、全量测试通过；安全审查 finding 逐项复现和关闭；不新增生产依赖。
- 边界：迁移 Codex connector、App Server client、runner、fake server 和三个直接测试；CLI 与 Demo 只更新必要 import，不迁移其实现。

## Red

机械改名后 `npm run typecheck` 产生 246 条诊断，集中在 JSON-RPC envelope、method result、notification、child process、pending request、abort 生命周期、错误对象与测试假体。

随后增加了可观察协议与安全红灯：

1. result/error 同时存在、未知 response ID、畸形 initialize/thread/start/turn/start 和 terminal notification；
2. 错配 thread/turn、command/file approval、服务端 error message 泄漏；
3. 项目内 junction 指向项目外、校验后仍把 lexical junction 传给 client；
4. shutdown timeout 后残留 `close` listener；
5. 不存在的 cwd 被延迟到 client/spawn 阶段，允许在校验后换成外部 junction。

每个审查问题均先保留失败证据，再修改生产实现；没有通过降低 strict 配置或跳过测试消除红灯。

## Green

- `JSON.parse` 结果保持 `unknown`，统一 envelope decoder 区分 notification、server request、result response 与 error response。
- Client response ID 必须是正安全整数；result/error 必须且只能出现一个；error code 必须是整数，message 有 UTF-8 大小上限。
- initialize、thread/start、turn/start 与 turn/completed 在调用点运行 method-specific decoder。
- terminal notification 必须携带匹配的 thread/turn 和受支持终态；错配立即返回 `CODEX_PROTOCOL_ERROR`。
- command/file approval request 始终返回 decline，并产生窄 observation。
- App Server error response 对外只保留固定 method 与整数 code，不传播不可信 message。
- line、stderr、timeout、abort、stop、kill、`shell: false`、`windowsHide: true` 与 provider credential 过滤行为保持原边界。
- Runner 只依赖窄 application service 与 client port；catch 的值保持 `unknown` 后再裁剪。
- cwd 同时执行 lexical 与 canonical containment；实际传给 client 的是 canonical path。路径不存在、无法解析或越界均在 `attempt.started` 前失败，错误正文不包含机器路径。
- `waitForClose` 在正常 close 与 timeout 两条路径都清除 listener，避免多次 stop 累积。

## 审查驱动修复

独立只读审查共识别并复现以下问题：

1. P1：不可信 App Server `error.message` 进入 runner 的 failed Attempt summary；
2. P2：realpath 校验成功后仍把原始 junction path 传给 client；
3. P2：不存在 cwd 的 `ENOENT` 分支返回 lexical path，保留校验后换靶窗口；
4. P3：shutdown 等待超时后 `close` listener 未移除。

四项均以 Red → Green 修复：错误正文固定化、向下传递 canonical cwd、无法 realpath 时 fail-closed、两条关闭路径移除 listener。回归同时确认失败发生在 Attempt 预留前，client 不启动且 journal 不新增记录。

## 验证证据

- `npm run typecheck`：通过，246 条诊断收敛为 0。
- Codex connector/client/runner 直接测试：29/29 通过。
- CLI 与 Demo import 间接回归：通过。
- `npm test`：242/242 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过；仅有 Windows working-copy 的 LF/CRLF 提示。
- 未发现 `any`、类型断言、类型忽略、旧本地 `.js` import、本地绝对路径、凭证、生成 JavaScript 或新增生产依赖。

## 剩余风险

- `realpath` 与子进程启动之间仍存在一般文件系统换靶竞态；本切片消除了稳定 junction 和不存在路径的明确绕过，但没有引入 OS 级目录句柄绑定。
- 本次以 fake App Server 与既有 read-only 集成行为验证协议；没有新增一次真实 Codex 外部调用。
- App Server 仍是可替换的 experimental transport；新增 method 必须增加独立 decoder，不能落回宽泛 envelope。

## 结论

支持假设。Codex runner 已进入 strict TypeScript，并强化了 JSON-RPC fail-closed、审批拒绝、错误脱敏、canonical cwd 和 shutdown 资源清理边界，可以作为 Server/Demo 与 CLI/Bin 迁移的前置基线。
