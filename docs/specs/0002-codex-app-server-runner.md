# 规格 0002：Codex App Server 首个 Runner

## 背景与问题

实验 0001 已证明 fixture 可以归一为可重放的交付证据链，但当前状态只存在于进程内，Codex 也只是一个 `attempt.started` fixture。TaskSeal 需要在不接触 Linear、GitHub 写权限的前提下，证明一个真实 Codex 进程能够被启动、观察、恢复并投影到 Control Room。

## 目标与成功指标

- 规范事件写入本地 append-only journal，进程重启后得到相同工作流。
- CLI 可以初始化本地状态、诊断 Codex、启动服务并运行一个既有 WorkItem。
- 首个 runner 通过 Codex App Server 的 JSONL JSON-RPC 协议创建 thread 和 turn。
- Codex turn 的开始、完成、失败或中断被归一为 Attempt 生命周期事件。
- Control Room 展示持久化 WorkItem 和当前 Attempt，而不是依赖固定 demo 步骤。
- 全部行为可使用本地 fake App Server 自动验证；真实冒烟不得修改项目文件。

## 范围内

- 单进程、单项目的本地事件 journal。
- 一个 WorkItem 同时最多一个活跃 Codex Attempt。
- `taskseal init`、`taskseal doctor`、`taskseal start`、`taskseal run <work-item-id>`。
- Codex App Server `initialize → initialized → thread/start → turn/start → turn/completed` 最小协议。
- runner 请求超时、进程提前退出、无效 JSON、失败 turn 和中断的显式错误。
- App Server 默认使用 `workspace-write` sandbox 与 `never` approval policy；越出 sandbox 的动作失败，不自动批准。
- 运行时清除与当前任务无关的外部平台凭证，避免将 GitHub、Linear、Gitee 或飞书凭证传给 Codex 子进程。

## 范围外

- 真实 Linear、GitHub、Gitee、飞书 API 或 Webhook。
- 创建、更新或关闭任何外部 Issue。
- 自动创建 PR、提取 Git diff、生成 Artifact 或 Evidence。
- 多进程 journal 写锁、分布式调度、多租户、RBAC 和云端部署。
- 通用 runner SDK、插件市场或 Symphony 兼容实现。
- 自动批准 App Server 发起的命令、文件或权限请求。

## 用户或系统场景

### 初始化和恢复

Given 项目尚无本地 TaskSeal journal  
When 操作者运行 `taskseal init`  
Then 创建被 Git 忽略的本地状态目录，并写入一个可运行的本地 WorkItem；重复运行不得重复创建事件。

Given journal 已有事件  
When TaskSeal 服务重启  
Then 逐行重放事件并得到相同 WorkItem、Attempt 和验收状态。

### 运行 Codex

Given WorkItem 存在且没有活跃 Attempt  
When 操作者运行 `taskseal run <work-item-id>`  
Then TaskSeal 先持久化 `attempt.started`，再通过 App Server 启动 thread 和 turn，并在终态持久化 `attempt.finished`。

Given turn 状态为 `completed`  
When 完成事件被应用  
Then Attempt 显示 `completed`，WorkItem 进入 `reviewing`，但没有 Artifact 和 Evidence 时仍不能 accepted。

Given turn 失败、被中断或 App Server 进程异常退出  
When runner 收到终态或错误  
Then Attempt 显示对应终态，WorkItem 进入 `blocked`，错误摘要可观察且不包含凭证。

### 安全和协议失败

Given App Server 发送命令或文件审批请求  
When TaskSeal runner 未配置人工审批通道  
Then 请求被拒绝或 turn 按 `never` policy 失败；TaskSeal 不自动授权。

Given journal 含无效 JSON 或事件无法重放  
When 服务启动  
Then 启动显式失败并指出行号，不忽略损坏数据。

## 功能需求

1. journal 使用一行一个 canonical DomainEvent 的 JSONL 格式。
2. application service 是 append、replay 和内存投影的唯一进程内写入者。
3. 同一个 `eventId` 和相同内容重复提交不追加；同 ID 不同内容必须失败。
4. journal 追加成功后才提交内存投影；追加失败不得改变当前状态。
5. App Server transport 必须使用参数数组启动子进程，不拼接 shell 命令。
6. JSON-RPC request 必须有关联 ID、超时和进程退出清理。
7. runner 不把实验协议字段泄漏到 WorkItem、Artifact、Evidence 或 AcceptanceDecision。
8. CLI 的人类可读输出不得打印 Token、完整子进程环境或未经裁剪的 stderr。

## 业务规则与不变量

- Agent turn 完成仍只是交付声明，不等于 WorkItem accepted。
- `attempt.finished` 只能结束已存在的 Attempt。
- completed Attempt 没有 Artifact 时进入 `reviewing`；failed/interrupted Attempt 进入 `blocked`。
- 新 Attempt 会继续沿用既有 supersede 规则。
- Acceptance 仍要求当前 Attempt 成功 completed、当前 Artifact revision 的全部 required Evidence，以及 accountable owner。
- 失败或中断终态保持 blocked；晚到的 Artifact/Evidence 只归档事实，不会隐式重新开启评审。
- 外部平台事实仍由对应 provider 负责，runner 不伪造 GitHub 或 Linear 结果。

## 数据、接口与状态变化

新增 canonical event：

```json
{
  "eventId": "codex:run-id:finished",
  "workItemId": "TS-1",
  "type": "attempt.finished",
  "occurredAt": "ISO-8601 timestamp",
  "payload": {
    "attemptId": "run-id",
    "outcome": "completed",
    "threadId": "thread-id",
    "turnId": "turn-id",
    "summary": "optional bounded summary"
  }
}
```

`outcome` 只能是 `completed`、`failed` 或 `interrupted`。错误摘要有长度上限，不保存完整 stderr。

## 错误与边界情况

- `WORK_ITEM_NOT_FOUND`：运行目标不存在。
- `ATTEMPT_ALREADY_ACTIVE`：目标已有活跃 Attempt。
- `JOURNAL_CORRUPT`：JSONL 无法解析或事件无法重放。
- `JOURNAL_WRITE_FAILED`：磁盘追加或同步失败。
- `CODEX_NOT_AVAILABLE`：无法启动 Codex。
- `CODEX_PROTOCOL_ERROR`：JSON-RPC 无效、未知 response ID 或握手失败。
- `CODEX_REQUEST_TIMEOUT`：请求或 turn 超时。
- `CODEX_PROCESS_EXITED`：进程在预期终态前退出。

## 权限、安全、隐私与审计影响

- 默认只连接本地 stdio，不监听网络端口。
- `cwd` 在运行时解析，并必须位于项目根目录内。
- Prompt 作为 JSON-RPC 数据写入 stdin，不进入 shell。
- 子进程环境清除常见外部 provider Token；Codex 自身认证由本机 Codex 管理。
- journal 是本地审计记录，目录必须加入 `.gitignore`。

## 兼容、迁移与回退

- 保留实验 0001 的 fixture replay 和 demo server 测试。
- 新持久模式通过依赖注入进入 server，不改变领域模块对具体存储的依赖方向。
- 如果 App Server 协议变化，只替换 runner transport；application service 与领域事件保持不变。
- 如果直接 JSON-RPC 维护成本过高，可在相同 runner 接口后切换 Codex SDK。

## 可观测性与运维要求

- `doctor` 报告 Node、项目配置、Codex binary 和登录状态，只输出布尔或摘要。
- runner 暴露 attempt、thread、turn、终态、开始/结束时间和裁剪错误。
- 服务收到终止信号时关闭 HTTP server 和 App Server 子进程。

## 验收标准

1. 临时目录中的 journal 在重开后可重放得到相同 dashboard。
2. 重复事件不增加 journal 行数；冲突事件不写入。
3. fake App Server 可以验证完整握手、thread、turn 和 completed 映射。
4. fake App Server 的失败、超时、提前退出和无效 JSON 都产生可识别错误并清理进程。
5. `npm test` 覆盖新增领域、journal、runner、CLI/server 行为并保持既有测试通过。
6. 真实 Codex read-only 冒烟完成一个不修改文件的 turn。
7. 浏览器可看到持久 WorkItem 及 Attempt 终态，且没有 Artifact/Evidence 时不能 accepted。
8. 项目文件不包含开发者机器绝对路径或凭证。

## 未决问题

- Linear tickets 是否创建：本里程碑默认不创建，等待操作者明确授权。
- 真实 GitHub/Linear 只读凭证形式：留到下一里程碑决定，不阻塞当前实现。
