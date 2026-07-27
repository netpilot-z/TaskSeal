# 实验 0011：Server 与 Demo TypeScript 迁移

## 实验卡

- 决策：能否在不迁移 CLI/bin、不引入 Web framework 的前提下，把本地 HTTP Server、Demo replay 和直接测试迁移到 strict TypeScript。
- 假设：demo/persistent 两种运行模式可以由判别联合表达；HTTP、fixture JSON、service health 和 caught error 继续通过运行时 guard 收窄，不需要 `any` 或公共框架。
- 反证：必须放宽 loopback、CSRF、content type、body limit、运行预留或 shutdown 规则；Demo replay 改变；service/runner 错误泄漏凭证或机器路径；CLI 无法继续消费 Server。
- 指标：类型检查、Server/Demo、CLI 间接和全量测试通过；浏览器完整 Demo 与重置可用；独立审查无剩余 P0–P3。
- 边界：迁移 `server`、`demo/scenario` 和两组直接测试；CLI 只更新必要 import，正式入口留给 T12.8。

## Red

机械改名后 `npm run typecheck` 产生 98 条诊断，集中在五类接缝：

1. demo fixture JSON 与 canonical event 的 `unknown` 边界；
2. demo/persistent 可选参数、service/runner duck type 和 Server `shutdown` 扩展；
3. IncomingMessage URL/header/body、response JSON 与 caught error；
4. active run、异步 gate、stalled request 和 shutdown 测试假体；
5. `noUncheckedIndexedAccess` 下的正则捕获、Map/array lookup 和测试 projection 读取。

安全红灯额外证明：

- primitive、null、array 和 string JSON 都必须在 runner 前返回 400；
- 原实现会把畸形 `Host: localhost:` 当作 loopback 并返回 202；
- 首轮迁移会把 `TaskSealServiceError/SERVICE_REOPEN_REQUIRED` 降级为 `INTERNAL_ERROR`。

## Green

- `DemoStep` 拥有 canonical event；fixture `JSON.parse` 保持 `unknown`，由既有 provider normalizer 校验。
- Server options 使用 demo/persistent 判别联合；runtime 只保留各自需要的 steps 或 service/runner 能力。
- Server 通过交叉类型公开 `shutdown(): Promise<void>`，不修改 Node 类型或引入 framework。
- HTTP URL、header、body chunk、JSON、health 与 error 均显式收窄；body 继续限制为 64 KiB。
- Host 使用完整 loopback grammar 校验，拒绝缺失、尾随冒号、非数字或越界端口；Origin、Sec-Fetch-Site 与 CSRF 规则保持。
- WorkItem 运行先同步预留 active map，再调用 runner；第二个并发请求继续返回 409。
- shutdown 先停止接单，Abort 已预留 run，等待 execution settled 后关闭连接；body 中途停顿的请求在预留前返回 503。
- runtime error 保留安全格式的 code，但不向 Control Room 返回任意 runner message。
- `TaskSealServiceError` 只保留经过格式白名单的 code；`SERVICE_REOPEN_REQUIRED` 与既有 fenced health 语义一致返回 503 和固定文案。

## 审查驱动修复

独立后端审查发现一项 P2：首轮错误规范化只识别 HttpError 与 DomainError，使 fenced service 的 dashboard/run 读取丢失 `SERVICE_REOPEN_REQUIRED`，变成 `INTERNAL_ERROR`。

修复先用 snapshot 与 getWorkItem 两条 HTTP 回归复现，再增加窄 service error 分支。两条回归同时放入 secret marker，确认 safe code 得以保留而原始 message 不进入响应。复审确认 503 与既有 `/health` fenced 契约一致，原 P2 关闭，未发现新增 P0–P3。

## 验证证据

- `npm run typecheck`：通过，98 条诊断收敛为 0。
- Server/Demo 直接测试：15/15 通过。
- CLI 间接测试：12/12 通过。
- `npm test`：246/246 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过；仅有 Windows working-copy 的 LF/CRLF 提示。
- TypeScript AST 扫描：目标文件 `any`、类型断言和 non-null escape 均为 0。
- 旧 `server.js` / `demo/scenario.js` import、类型忽略、测试跳过、本地绝对路径和凭证：均为 0。
- 本地浏览器：初始 Step 1/6 为 Planned；Run full loop 后 Step 6/6 为 Accepted、证据 1/1；Reset 后恢复 Step 1/6；console error/warning 为 0。

## 剩余风险

- Server 仍是单进程 loopback 控制面，不支持公网认证、多租户、跨进程运行预留或请求排空超时。
- shutdown 会等待已进入 runner 的 execution settle；若 runner 违反 Abort 契约永久不结束，shutdown 仍可能等待。
- `public/` 浏览器 JavaScript 不属于本切片，前端 TypeScript 工具链继续由 T13 的真实复杂度门槛决定。
- CLI 与 package bin 仍为 JavaScript，由 T12.8 独立迁移和验证 Windows/POSIX 入口。

## 结论

支持假设。Server 与 Demo 已进入 strict TypeScript，在保持零生产依赖的同时强化了 HTTP trust boundary、安全错误输出和 fenced 恢复信号，可以进入 CLI/Bin 最后一条迁移切片。
