# 审查 0024：稳定 Runner / 数字员工合同

## 范围

本次审查覆盖 Linear `NP-8` / T20：

- Runner v1 manifest、input/output 与 runtime decoder；
- application-owned Managed Runner Host；
- capability 与 Host permission；
- Attempt lifecycle、timeout/cancel terminalization、cleanup/fence；
- handoff trust boundary；
- Codex App Server Adapter、环境隔离与兼容 façade；
- fake Adapter、contract kit、CLI composition 与文档。

## 独立审查发现

首轮后端与架构审查发现：

1. deadline timer 被 `unref()` 后，handle-free hanging Adapter 可能永远不触发超时；
2. timeout/cancel 发出 Abort 后没有等待 Adapter settle，可能提前释放 coordinator
   容量并遗留子进程；
3. cancel 路径可能吞掉 cleanup failure，把未确认资源释放报告成成功；
4. Codex transport 的 cleanup 错误码没有归一到稳定 Runner 合同；
5. manifest workspace capability 被当成权限，缺少独立 Host policy。

第一轮修复后的后端复审又复现：

6. deadline 已先发生时，cleanup 等待窗口内的 operator cancel 仍会被接受，并把
   timeout failed 改成 interrupted。

## 修复与复审

- deadline timer 保持引用，并增加独立 handle-free 子进程回归。
- Host 对 deadline/cancel 执行 Abort 后 bounded await Adapter settlement；在 settle
  前 coordinator 容量不释放。
- cleanup 无法确认时，Host 写入已选 failed/interrupted 事实，传播
  `RUNNER_PROCESS_CLEANUP_FAILED`，并 fence 当前实例。
- Codex Adapter 把 transport-specific cleanup code 映射为稳定 Runner code。
- Host 增加独立 `allowedWorkspaceAccess` policy，默认只读；manifest capability
  不再授予权限，内置 Codex composition 显式允许 workspace-write。
- terminalization selection 改为幂等单选；deadline callback 在广播 Abort 前同步
  锁定 failed。新增回归证明 cleanup gate 未释放时 late cancel 返回
  `RUN_TERMINALIZING`，cleanup 后仍传播 `RUNNER_TIMEOUT` 并持久化 failed。
- terminal append 继续位于执行 catch 之外，不重试、不重新选择终态。

架构复审确认 permission/capability 和 cleanup/fence 两项 High 已闭环。后端复审
确认 late-cancel P1 已闭环，并额外以 20 次 deadline/同步 completion 压力复现确认
timeout-first 不会从 output 路径旁路；修复后未发现新的可执行问题。

## 验证证据

- 全量测试：`816/816` 通过，0 失败、0 跳过、0 取消。
- `npm run typecheck` 通过，无 TypeScript 诊断。
- late-cancel 定向 Runner suite：`19/19` 通过。
- 独立后端定向复审：Runner、Codex 与 coordinator `43/43` 通过。
- Runner/Codex contract、malformed output、secret isolation、cleanup/fence 与
  compatibility tests 全部包含在全量门禁中。
- `git diff --check` 通过。
- 真实只读 Codex App Server smoke 返回 completed 与 thread/turn identity，工作区
  无修改。
- 项目内容不包含开发者机器绝对路径或真实控制面凭证。

## 风险与限制

- 当前 contract 是进程内 TypeScript port，不等于可安装第三方插件 ABI；T22 需要
  定义 package/version/install boundary。
- 对外部进程的 cleanup 只能 bounded confirm；无法确认时采取 fence，而不是假设
  资源已释放。
- Host policy 目前由可信 composition 注入；远程团队场景还需要认证、RBAC、租户和
  审计模型。
- Runner handoff 不是交付真相，仍不能绕过 Artifact/Evidence provenance。

## 结论

NP-8 满足 T20 技术验证合同，可以进入 PR 与 CI 门禁。稳定 Runner 合同已经证明
Codex 与第二个 fake Adapter 可共享相同 Host lifecycle，同时保持权限、凭证、清理、
证据和终态裁决边界。
