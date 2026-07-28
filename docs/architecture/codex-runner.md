# Runner / Codex Adapter 架构

## 设计摘要

- 行为与非目标：以稳定 v1 合同运行可替换数字员工；首个实现是 Codex App Server，不承担外部 Issue 写回、PR 识别或动态加载不可信插件。
- 状态所有者：Domain workflow 拥有业务不变量；application service 拥有写入顺序；`ManagedAttemptRunner` 拥有 Attempt 生命周期；event journal 拥有持久事实；Adapter 只拥有执行 session。
- 依赖方向：CLI/HTTP 依赖 application Host；Host 依赖 TaskSeal service 与 runner-neutral port；Codex Adapter 依赖 App Server client；Domain 不依赖文件系统、Runner 或 Codex。
- 公共契约：canonical DomainEvent、`journal.readAll/append`、版本化 Runner manifest/input/output、`ManagedAttemptRunner.run`。
- 失败边界：存储错误、协议错误和 Codex turn 失败分别表达，不使用一个通用异常吞掉来源。

```text
CLI / HTTP
    │
    ▼
AttemptRunCoordinator
    │
    ▼
ManagedAttemptRunner ─────► TaskSealService ──► FileEventJournal
    │                              │
    │ versioned envelope           └──────────► Dashboard projection
    ▼
CodexAppServerRunnerAdapter
    │
    ▼
CodexAppServerClient ───── JSONL JSON-RPC ───► codex app-server
```

## 模块与职责

### `storage/event-journal.ts`

- 读取和追加 JSONL。
- 对损坏行给出稳定错误。
- 单次 append 后同步文件。
- 不解释业务事件，不创建 dashboard。

### `application/taskseal-service.ts`

- 串行化所有 append。
- 先用 `applyEvent` 计算候选状态，再持久化，最后替换内存状态。
- 打开时重放 journal。
- 提供 snapshot 和 WorkItem 查询。

### `runners/runner-contract.ts`

- 定义 exact v1 capability manifest、input/output envelope 与
  `DigitalEmployeeAdapter` port。
- 对 manifest 和 Adapter 的 `unknown` output 做有界 runtime decode。
- 冻结 Host 生成的 input，阻止 Adapter 改写 Attempt identity、deadline 或工作区。
- handoff 只允许 bounded `artifact` / `evidence` claim，不产生 canonical 事实。

### `application/managed-attempt-runner.ts`

- 验证 WorkItem、capability、instruction 与 canonical cwd。
- 把请求权限与独立 Host policy 求交集；默认 policy 只读，manifest 不能自行授权。
- 由 Host 分配 Attempt identity、时间和 end-to-end deadline。
- 只通过 TaskSeal service 原子记录 `attempt.started` / `attempt.finished`。
- 在终态 append 前调用 terminalization fence，统一处理完成、失败、取消、超时、
  Adapter throw 和畸形输出。
- deadline/cancel 先 Abort，再在 bounded cleanup window 内等待 Adapter settle；
  cleanup 未确认会传播稳定错误并 fence Host。
- 不把 TaskSeal service、journal、Provider client、环境或验收权限传给 Adapter。

### `runners/codex-app-server-client.ts`

- 启动和停止子进程。
- 完成 initialize handshake。
- 从 `unknown` 解码并关联 request/response。
- 处理通知、超时、无效 JSON 和进程退出。
- 拒绝未知 response ID、畸形 method result、错配 thread/turn 和两类 approval request。
- 外部 App Server 错误正文不进入异常或 Attempt 摘要。
- 子进程环境由显式 allowlist 构造，未列出的 key 在读取 value 前即被排除。
- bounded shutdown 必须确认 close；强制终止后仍未退出则显式失败。
- 不创建 DomainEvent。

### `runners/codex-runner.ts`

- `CodexAppServerRunnerAdapter` 把通用 instruction/workspace/signal 映射为 App Server
  turn，并把 thread/turn 映射为通用 runtime references。
- approval policy 固定为 `never`，通用合同不暴露 `danger-full-access`。
- `CodexRunner` 只保留旧调用外观的兼容 façade；生产 composition 直接组合通用
  Host 与 Codex Adapter。
- 不写 DomainEvent，也不能生成 Artifact、Evidence 或 Acceptance。

### CLI 与 HTTP

- CLI 管理 init、doctor、start 和 run。
- HTTP 只发送应用命令并读取 projection。
- 两者不得直接写 journal 或调用 `applyEvent`。
- `server.ts` 用 demo/persistent 判别联合隔离 fixture replay 与真实 service/runner 注入。
- HTTP URL、header、JSON body、service health 和 caught error 都先作为不可信输入收窄。
- Service 错误只保留经过格式校验的 code；面向浏览器的 message 使用固定安全文案。

## 数据与控制流

1. CLI/HTTP 请求运行 WorkItem，coordinator 分配易失容量与取消 fence。
2. Host 校验 capability/cwd，生成冻结 input，并通过 service 追加
   `attempt.started`。
3. Codex Adapter 启动 App Server，完成 handshake，创建 thread/turn。
4. Host 对 Adapter 的 `unknown` output 做 exact decode，或把 timeout/throw/malformed
   归一为安全结果。
5. Host 只选择一次终态并通过 service 追加 `attempt.finished`。
6. Control Room 读取相同 service projection；handoff claim 不进入 Artifact/Evidence。

## 错误与失败边界

- journal 追加失败：不启动或不提交下一状态。
- `attempt.started` 成功但 Codex 启动失败：追加 failed finish，留下可审计 Attempt。
- Adapter 返回跨 Attempt、未知字段、超长文本、accessor 或未声明 claim：追加安全
  failed finish，并向调用方返回 `RUNNER_OUTPUT_INVALID`。
- Host deadline exceeded：先同步锁定 terminalization，再 Abort Adapter 并追加
  failed；已先接受的 operator cancel 仍归一为 interrupted，cleanup 窗口内的
  late cancel 返回 `RUN_TERMINALIZING`。
- cleanup 未确认：保存已选终态、传播 `RUNNER_PROCESS_CLEANUP_FAILED` 并 fence
  Host；重建 runtime 前拒绝新派发。
- 取消成功且 interrupted finish 已落盘：Runner 返回结构化 interrupted result；finish 写入失败则传播 journal/service error，HTTP 投影安全诊断。
- terminal append 失败不重试、不重新选择终态，保留 running Attempt 供 reopen recovery。
- cwd 不存在、无法解析或 canonical path 越界：在 `attempt.started` 前返回固定错误，不持久化机器路径。
- App Server 未知通知：忽略并可记录摘要；未知 response ID 或无效 JSON：协议错误。
- App Server error response 只暴露 method 与整数错误码，不传播不可信服务端 message。
- HTTP 断开不取消已经开始的 runner；显式取消由后续命令实现。
- 单进程串行 queue 防止 HTTP 与 CLI 并发 append 分叉；多进程写入暂不支持。
- Persistent 写入口拒绝非 JSON、非 loopback Host、跨 Origin/Site、无效 CSRF 和超过 64 KiB 的 body。
- `SERVICE_REOPEN_REQUIRED` 保留可机器处理的安全 code 并返回 503，不传播 service 原始错误正文。

## 测试策略

- 领域单元测试：Attempt 完成、失败、中断和验收门禁。
- journal 单元测试：重放、去重、冲突、损坏行、写入失败。
- transport 契约测试：fake JSONL child process。
- Runner contract kit：同一套 manifest、完成和 cancel 契约同时验证 Codex Adapter
  与第二个 deterministic fake Runner。
- application 集成测试：两种 Adapter 产生相同 Attempt 生命周期形状，并覆盖
  malformed output、deadline、错误脱敏、handoff trust boundary 和 append failure。
- HTTP/CLI 测试：依赖注入 fake runner，不调用真实 Codex。
- 真实冒烟：read-only sandbox，只要求固定文本响应，不修改文件。

## 当前运行时选择

- Windows 会比较 PATH 中的 Codex 与本机 Codex App 内置 binary，选择可正常执行且版本较新的候选。
- `TASKSEAL_CODEX_BIN` 是显式覆盖入口，不把机器绝对路径写入项目文件。
- App Server 使用本地 stdio JSONL 和 `--strict-config`，每个 Attempt 创建一个独立进程、thread 和 turn。
- command/file approval request 默认 decline；approval policy 固定为 `never`。
- 子进程默认只继承 OS 启动、Codex 定位/认证与证书所需的显式环境 key；Linear、
  GitHub、Gitee、飞书、人工验收以及任何未知环境 key 都不会进入 Runner。
- Managed Host 默认只授权 read-only；本地 Codex composition 显式授权
  read-only/workspace-write，权限不是由 manifest 自报获得。
- Runner 将校验后的 canonical cwd 传给子进程；不存在的 cwd 不再推迟到 spawn 阶段处理。
- Control Room 写入口只接受 loopback、same-origin、`application/json` 与启动时随机 CSRF token，界面默认 read-only。
- 同一 WorkItem 的 Attempt 由 application service 原子预留；并发 HTTP 或 runner 调用只能有一个成功。
- Control Room 的易失运行控制由 application coordinator 拥有：默认并发 1、显式上限 8，每项独立 Abort，cancel 直到 terminal append 完成才释放容量；同步 terminalization fence 保证取消接受与持久终态一致；不同 WorkItem 在容量内可并行。
- HTTP `202` 只表示进程内 dispatch accepted；Runner 完成 cwd 校验和 `attempt.started` append 前，运行投影的 Attempt ID 可以为空。
- shutdown 会停止接单、Abort 活跃 turn 并等待终态；重启时遗留 running Attempt 被归一为 interrupted。

## 替代方案与取舍

- 更简单方案：直接使用 `codex exec`。实现更少，但无法验证 App Server 的 thread、turn、审批和流式事件，因此不选。
- 主要替代：安装 Codex SDK。官方更推荐 SDK 用于自动化，但当前用户明确选择 App Server，并且原型希望验证深度产品集成；先用窄 transport，协议成本过高时可替换。
- Symphony：其调度、workspace 和 retry 设计继续作为后续参考，本切片不引入第二个 orchestrator。

## 迁移步骤与回退

1. 先引入 journal/service，不改变 demo。
2. 再加入 Attempt 终态和 fake App Server transport。
3. 再接 CLI 与持久 server。
4. 最后做真实 read-only smoke。
5. 抽出 v1 contract 与 application-owned Host，让 Codex 退为首个 Adapter，并以
   第二个 fake Runner 验证可替换性。
6. 任一步失败可退回 Codex 兼容 façade或 fixture demo；Domain/journal 无需迁移。
