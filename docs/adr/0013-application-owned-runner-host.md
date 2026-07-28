# ADR 0013：由应用层 Runner Host 统一管理数字员工生命周期

## 状态

已接受。

## 背景

现有 `CodexRunner` 把 Codex JSON-RPC transport 与 TaskSeal Attempt 生命周期放在
同一个类中。它适合第一个技术实验，却导致每个新 Runner 都必须复制 WorkItem
校验、cwd containment、Attempt reservation、取消竞态和终态持久化。复制会让
不同数字员工产生不同事实，也让畸形输出可能在 started 之后留下永远 running
的 Attempt。

## 决策

引入三层边界：

1. `runner-contract` 定义版本化、可 runtime decode 的 manifest/input/output 和
   `DigitalEmployeeAdapter` port；
2. application-owned `ManagedAttemptRunner` 是唯一管理持久 Attempt 生命周期的
   Host；
3. `CodexAppServerRunnerAdapter` 只负责把通用 input 映射到 App Server transport，
   `CodexRunner` 仅保留兼容 façade。

Host 拥有 Attempt identity、cwd 边界、deadline、cancel terminalization fence、
output decode 和 started/finished event。Adapter 看不到 TaskSeal service、journal、
Provider client 或 Acceptance port。

Host 还拥有独立于 manifest 的 `allowedWorkspaceAccess` policy，默认只读。有效权限
必须同时存在于本地 policy 与 Adapter capability；内置 Codex composition 对写权限
作显式授权。

deadline 或 operator cancel 会先 Abort Adapter，再在 bounded cleanup window 内
等待 settle。cleanup 未确认时，Host 保存已经选定的 failed/interrupted 事实，但
向调用方传播稳定 `RUNNER_PROCESS_CLEANUP_FAILED` 并 fence 当前 Host，直到 runtime
重建；因此 coordinator 不会在正常 cleanup 完成前释放容量，也不会把资源泄漏报告为
成功取消。

deadline 的 terminalization 选择必须在广播 Abort 前同步锁定。这样 Adapter 进入
异步 cleanup 后才到达的 operator cancel 会被 coordinator 拒绝，不能把已经成立的
timeout `failed` 改写为 `interrupted`；只有 deadline 前已接受的 cancel 保留优先级。

Runner handoff 只是不可信 claim。canonical Artifact/Evidence 仍由显式 mapping、
Provider readback 与 provenance reconciliation 产生。

## 选择理由

- 生命周期规则只有一个实现，第二个 Runner 无需接触 Domain。
- Adapter 输出按 `unknown` 解码，可以在持久化前阻断越权或畸形结果。
- Host-owned deadline 为所有实现提供一致失败语义。
- capability manifest 可以成为后续注册和调度的稳定输入，但不会被误当权限。
- 默认只读 policy 让新 Adapter 不能通过自报 capability 提权。
- 保留兼容 façade，CLI、server 和历史 journal 不需要一次性迁移。

## 被拒绝方案

### 只重命名 CodexRunner 类型

它不会消除硬编码的 Codex client、agent identity 和生命周期写入，新 Runner 仍要
复制实现，因此不采用。

### 每个 Runner 自己写 Attempt 事件

这会把 journal authority 和 Domain port 暴露给执行面，并允许 Runner 自报时间、
事件 ID 或验收事实，因此不采用。

### Runner 直接返回 canonical Artifact/Evidence

Agent 文本或自报测试结果不具备 Provider provenance。直接采信会破坏现有验收
不变量，因此只允许 bounded untrusted claims。

### 首版动态加载第三方 in-process 插件

同进程代码可以读取控制面内存、环境和文件，无法兑现凭证隔离。首版只内置受信
Adapter；第三方隔离进程协议留给 CLI/SDK 里程碑。

### 为通用合同暴露 Codex approval policy

`on-request`、`never` 等是 Codex transport 词汇。通用合同只描述工作区访问，
内置 Codex Adapter 固定 `never`，避免调用方通过 capability 声明提权。

## 影响

正面：

- Codex 成为可替换实现而不是系统边界。
- cancel、timeout、throw、malformed output 和 journal failure 有统一语义。
- contract kit 可以用于未来 SDK 和插件兼容验证。
- Runner 无法直接伪造 Artifact、Evidence 或 Acceptance。

限制：

- v1 的 runtime references 仍映射到 Domain 的 legacy `threadId` / `turnId`。
- Host timeout 能给出持久终态，但真正释放外部资源仍要求进程 Adapter 实现
  bounded cleanup；未确认 cleanup 会 fence Host，而不是继续派发。
- 测试 fake 可以 in-process；生产第三方 Adapter 暂不开放动态加载。
- handoff claim 只返回给调用方，尚未建立持久 claim inbox。

## 回退

保留 Codex façade的旧调用外观。回退时可把 façade重新指向旧实现；Domain、
journal、Control Room API 和历史事件无需迁移。
