# 规格 0022：稳定 Runner / 数字员工合同

## 背景与问题

TaskSeal 已经可以通过 Codex App Server 执行 WorkItem，但现有 `CodexRunner`
同时负责 Codex transport、Attempt 生命周期、工作区边界、取消裁决和持久化。
第二个执行器如果照此接入，只能复制这些规则，无法证明数字员工可替换，也无法
保证不同实现产生一致、可复核的 Attempt 事实。

本规格建立首个版本化 Runner 合同。合同的首要目标不是动态加载任意代码，而是
把受信的控制面与可替换执行面分开，为后续能力注册、任务调度和插件开发包提供
稳定接缝。

## 目标与成功指标

- Codex App Server 退为首个 Runner Adapter。
- application-owned Host 统一创建和终结 Attempt。
- 第二个 deterministic fake Runner 不修改 Domain 即可接入。
- Runner manifest、input 和 output 都有严格的 v1 runtime decoder。
- operator cancel、deadline timeout、Adapter throw 和畸形输出都产生唯一终态。
- Runner 进程只获得显式白名单环境，不获得 Linear、GitHub 或人工验收凭证。
- Artifact/Evidence handoff 只是不可信 claim，不直接形成 canonical 事实。
- 一个可复用 contract test kit 同时验证 Codex Adapter 和第二个 fake Runner。

## 范围内

- `RunnerCapabilityManifestV1`。
- `RunnerExecutionInputV1` / `RunnerExecutionOutputV1`。
- `DigitalEmployeeAdapter` port。
- application-owned `ManagedAttemptRunner`。
- `read-only` / `workspace-write` 两种通用工作区权限。
- Host-owned end-to-end deadline、AbortSignal 和 terminalization fence。
- bounded summary、runtime references 和 handoff claims。
- Codex Adapter、Codex 兼容 façade 与显式环境白名单。
- malformed/adversarial output、cancel/timeout、secret isolation contract tests。

## 范围外

- 动态加载或执行未经信任的第三方 JavaScript。
- `danger-full-access`、自动批准或任意控制面写权限。
- Runner 直接创建 Artifact、Evidence、AcceptanceDecision 或 ProviderOperation。
- Agent 市场、计费、远程租户、持久队列或分布式调度。
- 重命名既有 Domain `threadId` / `turnId` 字段或迁移历史 journal。

## 合同模型

### Capability manifest

manifest 必须是 exact plain object，并包含：

- `schemaVersion: "1"`；
- 稳定的 `runnerId` 和展示名称；
- 支持的工作区权限；
- 是否支持 cancel 和 timeout；
- 可返回的 handoff claim kind。

manifest 只声明能力，不授予权限。Host 仍要把请求权限与本地 allowlist 求交集，
并拒绝 Adapter 未声明的权限。Host policy 默认只授权 `read-only`；内置本地
Codex composition 必须显式授权 `workspace-write`，不能从 manifest 推导授权。
首版受管 Runner 必须支持 cancel 和 timeout。

### Input envelope

Host 生成 input，Runner 不得自行指定 Attempt identity、事件 ID 或时间：

```json
{
  "schemaVersion": "1",
  "attemptId": "host-assigned-id",
  "workItemId": "TS-1",
  "instruction": "bounded instruction",
  "workspace": {
    "root": "runtime project root",
    "cwd": "runtime canonical cwd",
    "access": "read-only"
  },
  "deadlineAt": "ISO-8601 timestamp"
}
```

input 不包含 WorkItem external links、Provider client、Token、journal port、验收权限
或原始环境变量。AbortSignal 通过不可序列化的 execution context 单独传递。

### Output envelope

Runner 的返回值在 Host 看来始终是 `unknown`，必须经过 exact decoder：

```json
{
  "schemaVersion": "1",
  "attemptId": "host-assigned-id",
  "outcome": "completed",
  "summary": "bounded optional summary",
  "runtimeRefs": {
    "sessionId": "optional opaque id",
    "executionId": "optional opaque id"
  },
  "handoffClaims": []
}
```

`outcome` 只能是 `completed`、`failed` 或 `interrupted`。Attempt identity 必须与
input 相同。未知字段、accessor、非 plain object、稀疏数组、越界字符串、未声明
claim kind 或伪造 Domain event 都按畸形输出处理。

### Artifact/Evidence handoff

v1 支持两类 bounded claim：

- `artifact`：kind、revision、locator；
- `evidence`：criterion、outcome、artifactRevision、locator。

这些对象明确命名为 claim。Host 只把它们作为本次调用结果返回，不写
`artifact.linked` / `evidence.recorded`，也不据此接受 WorkItem。它们必须由
显式 WorkItem/Provider mapping 和既有 provenance reconciliation 再验证。

## Attempt 生命周期

1. Host 校验 WorkItem、instruction、权限和 canonical cwd。
2. Host 分配 Attempt ID，并通过 `startAttemptIfIdle` 原子持久化
   `attempt.started`。
3. Host 生成 deadline，调用 Adapter。
4. Host 对 `unknown` output 做 runtime decode，或把 Adapter 错误归一为安全失败。
5. Host 在 `terminalization.begin()` 处只选择一次最终 outcome；deadline 到达时必须
   在向 Adapter 广播 Abort、等待 cleanup 之前同步锁定该选择。
6. 已接受的 operator cancel 优先于晚到 completion，形成 `interrupted`。
7. deadline 或 operator cancel 先 Abort Adapter，再在独立 bounded cleanup window
   内等待 Adapter settle；在清理完成前 Host Promise 不得 settle。
8. deadline exceeded 形成 `failed`；如果 operator cancel 已先被接受，则仍为
   `interrupted`。deadline 后、cleanup settle 前到达的 late cancel 必须返回
   `RUN_TERMINALIZING`，不能改写已选终态。
9. Host 追加唯一 `attempt.finished`。终态 append 失败必须向上游传播并保留
   running Attempt，供已有重启恢复逻辑收敛。
10. cleanup 未确认时仍提交已选的 failed/interrupted 事实，但必须向调用方传播
    `RUNNER_PROCESS_CLEANUP_FAILED` 并 fence 当前 Host；重建 runtime 前不得派发新
    Attempt。

Adapter 正常返回 `failed` 与 Adapter throw 是两条兼容语义：前者返回受管结果，
后者先持久化 failed，再把原始调用错误向上游抛出。

## 安全与隔离

- 通用 input 永不携带环境或控制面 port。
- Codex 子进程环境使用显式 key allowlist；未列出的 key 在读取 value 前即被过滤。
- OS 启动所需变量和 Codex 专用认证定位变量可由内置 composition 明确加入。
- Linear、GitHub、Gitee、飞书和人工验收凭证不得进入 Runner 进程。
- Prompt 仍作为协议数据写入 stdin，不拼接 shell。
- 工作区必须通过 lexical 与 canonical realpath 双重 containment。
- 通用合同不暴露 `danger-full-access` 或自动审批。
- 第三方 Runner 首版不支持 in-process 动态加载；测试 fake 是唯一例外。

## 错误与边界

- `RUNNER_MANIFEST_INVALID`：manifest 不是受支持的 exact v1 对象。
- `RUNNER_CAPABILITY_MISSING`：缺少 cancel/timeout 或请求未声明权限。
- `RUNNER_PERMISSION_DENIED`：请求权限不在 Host 本地 allowlist。
- `RUNNER_INPUT_INVALID`：instruction、timeout 或输入边界无效。
- `RUNNER_OUTPUT_INVALID`：output 身份、结构、长度或 capability 不合法。
- `RUNNER_TIMEOUT`：end-to-end deadline exceeded。
- `RUNNER_CWD_UNAVAILABLE` / `RUNNER_CWD_OUTSIDE_PROJECT`：工作区失败关闭。
- `RUNNER_PROCESS_CLEANUP_FAILED`：Adapter 进程在 bounded shutdown 后仍未确认退出。
- `RUNNER_CLEANUP_FENCED`：先前 cleanup 未确认，当前 Host 必须重建后才能派发。

错误 message 不作为 Evidence。未知 Adapter error 的持久摘要使用固定安全文本；
只有内置 Adapter 显式标记的 public summary 可以进入 journal。

## 兼容与迁移

- Domain event schema、journal reader 和 WorkItem projection 不变化。
- Codex 兼容 façade 保留原 `prompt` / `sandbox` / `threadId` / `turnId` 外观。
- Codex Adapter 把通用 `sessionId` / `executionId` 映射到既有 optional 字段。
- 旧 Attempt 可原样 replay；新 Attempt 的 agent identity 来自 validated manifest。
- demo fixture connector 暂不并入真实 Runner contract，避免重复创建 Attempt。

## 验收标准

1. Codex Adapter 和第二个 fake Runner 通过同一 contract suite。
2. 固定 ID/clock/outcome 下，两者产生相同形状的 started/finished 生命周期事实；
   只允许 runner identity 和 optional runtime refs 不同。
3. malformed、cross-attempt、extra-field、oversized 和未声明 handoff 输出安全失败，
   不遗留无终态 Attempt。
4. completed 只让 WorkItem 进入 reviewing，不自动产生 Artifact、Evidence 或 Acceptance。
5. operator cancel 归一为 interrupted；Host timeout 归一为 failed；late cancel 不改写
   已锁定终态。
6. Adapter 支持 write 但 Host policy 仅授权 read 时，在 Attempt reservation 前拒绝。
7. 子进程环境读取前即排除所有非 allowlist key，控制面凭证不出现在 spawn options。
8. Codex 子进程 bounded shutdown 未确认 close 时显式失败并 fence Host；coordinator
   在 cleanup settle 前不释放容量。
9. CLI、Control Room、既有 Codex transport 测试和全量回归保持通过。

## 回退

Domain 和 journal 没有迁移。出现问题时可以让 Codex 兼容 façade临时恢复旧内部
生命周期实现；关闭其他 Adapter 注册即可回到单 Codex Runner。
