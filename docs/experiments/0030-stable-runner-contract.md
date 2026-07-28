# 实验 0030：稳定 Runner / 数字员工合同

## 假设

在不引入生产依赖、动态插件加载或控制面凭证下放的前提下，可以把 Codex App
Server 降为第一个可替换执行 Adapter，并由应用层统一拥有：

- capability manifest 与本地 permission policy；
- 冻结的 v1 input/output envelope；
- WorkItem 校验、Attempt reservation 与唯一终态；
- end-to-end deadline、operator cancel、bounded cleanup 与 Host fence；
- 不可信 Artifact/Evidence handoff claim；
- 可复用于第二个 Adapter 的 contract test kit。

## 反证条件

- 第二个 fake Adapter 接入时必须修改领域模型或事件语义。
- manifest 的 capability 声明可以自行获得 workspace 写权限。
- Runner 能读取 Linear/GitHub 等控制面凭证。
- output 可以跨 Attempt、携带未知字段或直接生成 canonical Artifact/Evidence。
- timeout/cancel 后 Host 在 Adapter cleanup 未 settle 时提前释放容量。
- cleanup 未确认后，同一 Host 仍可继续派发。
- deadline 已发生后到达的 cancel 可以把 `failed` 改写为 `interrupted`。
- terminal append 失败会触发重试或重新选择 outcome。

## TDD 过程

1. 先以 manifest/input/output decoder 测试锁定 exact plain-object schema、大小边界、
   prototype/accessor/symbol/sparse array 防护与跨 Attempt 约束。
2. 以同一 contract kit 驱动 deterministic fake Adapter 与 Codex App Server
   Adapter，锁定 manifest、completed output 与 Abort settle。
3. 以 Managed Runner tests 锁定 Host-owned Attempt lifecycle、canonical cwd、
   capability/permission 双门禁、safe failure 与 untrusted handoff。
4. 以 handle-free 子进程测试证明 deadline/cancel 本身能保持进程存活到 bounded
   cleanup 判定，不依赖被 `unref()` 的 timer。
5. 以 delayed cleanup、capacity、cleanup failure 与 fence 测试锁定 Host 在
   Adapter settle 前不返回，未确认清理传播稳定错误并拒绝后续派发。
6. 以环境 getter 探针锁定 Runner 只读取显式 allowlist；即使扩展 allowlist，也不能
   放行控制面凭证。
7. 独立审查发现 permission/capability 混用、cleanup 未等待、cancel 吞掉 cleanup
   failure、错误码漂移和 handle-free timeout 风险；逐项建立红灯并修复。
8. 复审又复现 deadline 已触发、cleanup 未完成时的 late cancel 竞态。新增测试先
   证明 cancel 被错误接受，再让 deadline 在广播 Abort 前同步锁定
   terminalization；修复后 cancel 稳定返回 `RUN_TERMINALIZING`，最终保留
   `RUNNER_TIMEOUT` 与 failed Attempt。

## 已验证行为

- `DigitalEmployeeAdapter` 是窄 v1 port；Codex 只负责 transport 映射。
- capability 只是能力声明，本地 Host policy 默认只读；两者都通过才会 reservation。
- 第二个 fake Adapter 不修改 Domain 即产生与 Codex 相同的 normalized Attempt
  lifecycle facts。
- input 由 Host 分配 Attempt identity、workspace 与 deadline 并冻结。
- output 按 `unknown` exact decode；handoff 仅返回 claim，不写 canonical
  Artifact/Evidence。
- deadline、cancel、Adapter throw、malformed output 和 terminal append failure
  具有唯一且可审计的终态边界。
- deadline/cancel 会 Abort Adapter 并 bounded await settlement；清理未确认时提交
  已选终态、传播 `RUNNER_PROCESS_CLEANUP_FAILED` 并 fence Host。
- deadline 会在 Adapter 观察 Abort 前锁定 failed；只有更早接受的 cancel 能形成
  interrupted。
- App Server 子进程环境使用显式 allowlist，控制面凭证永不透传。

## 验证结果

- 新 late-cancel 回归修复前失败，修复后定向 Runner suite `19/19` 通过。
- 全量测试：`816/816` 通过，0 失败、0 跳过、0 取消。
- TypeScript：`tsc --noEmit` 通过。
- Codex doctor：本地 App Server 版本与登录状态 ready。
- 真实只读 Runner smoke：获得 completed、thread/turn identity 与预期安全摘要，
  工作区无修改。
- `git diff --check` 通过。
- 独立架构复审确认 permission/capability 与 cleanup/fence 边界闭环。

## 结论

技术假设成立。NP-8 已把 TaskSeal 的执行端从 Codex 专用类提升为稳定的
application-owned Runner Host 加可替换 Adapter，并保留本地优先、最小权限和可复核
Attempt 事实。

## 已知边界

- 当前只内置 Codex Adapter；第三方进程加载、签名、安装和兼容诊断属于 T22。
- handoff claim 仍需既有 mapping/provenance reconciliation 才能成为交付事实。
- cleanup fence 是进程内安全边界；恢复方式是重建 runtime，不是自动证明泄漏进程已
  退出。
- 当前环境 allowlist 面向 Codex App Server；每类外部 Runner 仍需独立最小环境合同。
