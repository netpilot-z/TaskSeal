# 审查 0007：Codex Runner TypeScript 迁移

## 状态

通过。对应 GitHub Issue `#16`；审查对象是 Codex connector、stdio JSON-RPC client、runner、fake server、直接测试与必要 JavaScript consumer import。

## 独立审查范围

进行了相互独立的只读 pass：

1. 协议与架构 pass：unknown decoder、method-specific result、thread/turn 关联、service/client port、Attempt 映射和扩展名闭包。
2. 安全与生命周期 pass：approval、凭证、cwd containment、错误持久化、timeout/abort/stop、child process 和 listener。
3. Verification pass：类型检查、直接与间接测试、全量测试、diff、旧 import、类型逃生口、绝对路径和凭证扫描。

## Finding 与闭环

### P1：App Server 错误正文可进入持久化摘要

初始 error response 将服务端 `message` 放入 `CODEX_RESPONSE_ERROR`，runner 会把该异常正文保存为 failed Attempt summary。

修复后 decoder 仍验证 message 的类型和大小，但生产异常只输出固定 method 与整数 code。fake server 的 secret marker 回归确认异常与 Attempt summary 均不包含原文。

### P2：校验 canonical cwd 后仍传 lexical path

初始实现用 realpath 验证稳定 junction，却仍把原始 lexical cwd 传给 client，保留 junction 后续解析差异。

修复后 resolver 返回 canonical candidate，runner 将该值传给 client；项目内指向项目外的 junction 继续失败关闭。

### P2：不存在 cwd 的 ENOENT 放行

初始兼容分支在 candidate 不存在时返回 lexical path，允许在验证后、spawn 前把该路径创建为指向项目外的 junction。

修复后 project root 或 cwd 任一 realpath 失败均返回固定 `RUNNER_CWD_UNAVAILABLE`。回归确认 client factory 未调用、WorkItem 保持 planned、Attempt 为零且 journal 没有新增事件。

### P3：shutdown timeout 残留 listener

初始 `waitForClose` 超时只 resolve，没有移除一次性 `close` listener。

修复后 close 与 timeout 分支都移除 listener，close 分支同时清除 timer；重复 timeout 回归确认 listener 数量不累积。

复审确认以上 finding 均关闭，未发现新增 P0–P3。

## 验证证据

- `npm run typecheck`：通过。
- Codex connector/client/runner 直接测试：29/29 通过。
- CLI 与 Demo import smoke：通过。
- `npm test`：242/242 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过。
- 未发现 `any`、双重断言、TypeScript ignore、non-null escape、测试 `.skip/.todo/.only`、本地绝对路径、凭证或旧目标 `.js` import。

## 剩余风险

- canonical path 检查无法从用户态完全消除校验到 spawn 之间的一般目录替换竞态；要完全绑定目录身份需要平台级句柄方案，超出本地 runner 原型范围。
- 本次未新增真实 Codex smoke；既有真实 read-only 能力不变，协议变化由 fake transport 完整覆盖。
- 新 App Server method 或 payload 版本仍需显式扩展 decoder 和 fixture。

## 结论

Issue `#16` 已建立严格且可复核的 Codex runner 类型边界，保持默认拒绝审批、最小环境、Attempt 可审计性与可替换 transport，同时关闭了错误泄漏、cwd 和 shutdown 资源问题。
