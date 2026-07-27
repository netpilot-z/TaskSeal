# 审查 0008：Server 与 Demo TypeScript 迁移

## 状态

通过。对应 GitHub Issue `#17`；审查对象是本地 HTTP Server、Demo fixture/replay、直接测试与 CLI 必要 import。

## 独立审查范围

进行了两个独立只读 pass：

1. 后端与安全 pass：HTTP Host/Origin/Site/CSRF/content type/body limit、service/health/error、运行预留、active/stalled shutdown、静态资源和模式边界。
2. Verification pass：类型检查、Server/Demo 与 CLI 间接测试、全量测试、diff、旧 import、类型逃生口、测试跳过、绝对路径和凭证。

另用本地浏览器检查页面加载、完整 Demo、Reset、可访问状态文本与 console。

## Finding 与闭环

### P2：已知 service 错误码被降级为 INTERNAL_ERROR

首轮 `normalizeResponseError` 只识别 HttpError 与 DomainError。`snapshot()` 或 `getWorkItem()` 在 fenced service 上抛 `TaskSealServiceError/SERVICE_REOPEN_REQUIRED` 时，HTTP 返回 `INTERNAL_ERROR`，调用方无法判断必须 reopen。

修复后：

- 只在 `name === "TaskSealServiceError"` 的窄分支读取 error code；
- code 必须满足大写字母、数字和下划线的长度限制；
- `SERVICE_REOPEN_REQUIRED` 返回 503 与固定安全文案；
- 其他 service error 使用 500 与固定通用文案；
- 不传播任意原始 message。

新增 dashboard/snapshot 与 run/getWorkItem 两条回归，同时断言 secret marker 不进入响应。复审认为 503 与既有 fenced `/health` 语义一致，原 P2 关闭。

最终未发现其他 P0–P3。

## 验证证据

- `npm run typecheck`：通过。
- Server/Demo：15/15 通过。
- CLI：12/12 通过。
- `npm test`：246/246 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过。
- 目标 TypeScript AST 中 `any`、类型断言、non-null escape：0。
- 旧目标 `.js` import、TypeScript ignore、测试 `.skip/.todo/.only`、本地绝对路径和凭证：0。
- 浏览器完成 planned → accepted → reset，页面 title 为 TaskSeal Control Room，console error/warning 为 0。

## 剩余风险

- Server 没有公网认证、RBAC、租户隔离或分布式 reservation；仍只允许 loopback。
- body 超限后会继续消费连接再返回 413，与迁移前行为一致；公网级 DoS 防护不在本地原型范围。
- shutdown 依赖 runner 响应 Abort；当前 Codex client 有有界中断测试，但通用 RunWorkItem port 无法强制第三方实现终止。
- 浏览器走查覆盖 Demo；persistent Server 的安全、并发和 shutdown 由 HTTP 集成测试覆盖，没有触发真实 Codex turn。

## 结论

Issue `#17` 已在不引入 NestJS、monorepo 或生产依赖的情况下建立严格 HTTP 与 Demo 类型边界，保留本地控制面的安全门禁和可审计恢复语义，可以进入 CLI/Bin 迁移。
