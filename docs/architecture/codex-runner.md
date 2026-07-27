# Codex Runner 架构

## 设计摘要

- 行为与非目标：运行并观察一个真实 Codex turn；不承担外部 Issue 写回、PR 识别或通用调度。
- 状态所有者：Domain workflow 拥有业务不变量；application service 拥有进程内写入顺序；event journal 拥有持久事实；runner 只拥有子进程和 JSON-RPC session。
- 依赖方向：CLI、HTTP 和 runner 依赖 application service；service 依赖 journal 接口与纯领域函数；领域模块不依赖文件系统或 Codex。
- 公共契约：canonical DomainEvent、`journal.readAll/append`、`runner.run`。
- 失败边界：存储错误、协议错误和 Codex turn 失败分别表达，不使用一个通用异常吞掉来源。

```text
CLI / HTTP
    │
    ▼
TaskSealService ───────► Dashboard projection
    │
    ├── append/replay ─► FileEventJournal
    │
    └── run request ───► CodexRunner
                           │
                           ▼
                    AppServerClient
                           │ JSONL JSON-RPC
                           ▼
                    codex app-server
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

### `runners/codex-app-server-client.js`

- 启动和停止子进程。
- 完成 initialize handshake。
- 关联 request/response。
- 处理通知、超时、无效 JSON 和进程退出。
- 不创建 DomainEvent。

### `runners/codex-runner.js`

- 验证 WorkItem、cwd 和 Prompt。
- 将 App Server 生命周期映射为 runner result。
- 通过 service 记录 Attempt 事件。
- 默认不处理或批准 App Server 权限请求。

### CLI 与 HTTP

- CLI 管理 init、doctor、start 和 run。
- HTTP 只发送应用命令并读取 projection。
- 两者不得直接写 journal 或调用 `applyEvent`。

## 数据与控制流

1. CLI 请求运行 WorkItem。
2. service 生成并追加 `attempt.started`。
3. runner 启动 App Server，完成 handshake。
4. runner 创建 thread 和 turn，等待 `turn/completed`。
5. service 追加 `attempt.finished`。
6. Control Room 读取相同 service projection。

## 错误与失败边界

- journal 追加失败：不启动或不提交下一状态。
- `attempt.started` 成功但 Codex 启动失败：追加 failed finish，留下可审计 Attempt。
- App Server 未知通知：忽略并可记录摘要；未知 response ID 或无效 JSON：协议错误。
- HTTP 断开不取消已经开始的 runner；显式取消由后续命令实现。
- 单进程串行 queue 防止 HTTP 与 CLI 并发 append 分叉；多进程写入暂不支持。

## 测试策略

- 领域单元测试：Attempt 完成、失败、中断和验收门禁。
- journal 单元测试：重放、去重、冲突、损坏行、写入失败。
- transport 契约测试：fake JSONL child process。
- application 集成测试：start → finish → restart replay。
- HTTP/CLI 测试：依赖注入 fake runner，不调用真实 Codex。
- 真实冒烟：read-only sandbox，只要求固定文本响应，不修改文件。

## 当前运行时选择

- Windows 会比较 PATH 中的 Codex 与本机 Codex App 内置 binary，选择可正常执行且版本较新的候选。
- `TASKSEAL_CODEX_BIN` 是显式覆盖入口，不把机器绝对路径写入项目文件。
- App Server 使用本地 stdio JSONL 和 `--strict-config`，每个 Attempt 创建一个独立进程、thread 和 turn。
- command/file approval request 默认 decline；approval policy 固定为 `never`。
- 常见 GitHub、Linear、Gitee、飞书环境凭证不会传入 runner 子进程。
- Control Room 写入口只接受 loopback、same-origin、`application/json` 与启动时随机 CSRF token，界面默认 read-only。
- 同一 WorkItem 的 Attempt 由 application service 原子预留；并发 HTTP 或 runner 调用只能有一个成功。
- shutdown 会停止接单、Abort 活跃 turn 并等待终态；重启时遗留 running Attempt 被归一为 interrupted。

## 替代方案与取舍

- 更简单方案：直接使用 `codex exec`。实现更少，但无法验证 App Server 的 thread、turn、审批和流式事件，因此不选。
- 主要替代：安装 Codex SDK。官方更推荐 SDK 用于自动化，但当前用户明确选择 App Server，并且原型希望验证深度产品集成；先用窄 transport，协议成本过高时可替换。
- Symphony：其调度、workspace 和 retry 设计继续作为后续参考，本切片不引入第二个 orchestrator。

## 迁移步骤与回退

1. 先引入 journal/service，不改变 demo。
2. 再加入 Attempt 终态和 fake runner。
3. 再接 CLI 与持久 server。
4. 最后做真实 read-only smoke。
5. 任一步失败可退回 fixture demo；journal 文件位于被忽略的本地目录。
