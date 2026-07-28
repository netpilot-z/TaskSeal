# ADR 0010：由应用层拥有 Attempt 运行协调

## 状态

已接受。

## 背景

Control Room 原先在 HTTP server 内维护 `Map<workItemId, AbortController>`。它能阻止同一 WorkItem 重复运行，却没有全局并发上限、单项取消或可投影的 run phase；前端还会因为任意运行存在而禁用唯一派发按钮。

领域层已经能持久化 Attempt started/finished、interrupted 终态与后续新 Attempt，因此无需扩展 canonical event schema。需要决策的是易失运行控制应由谁拥有。

## 决策

新增 application-owned `AttemptRunCoordinator`：

- 同步完成 per-WorkItem 去重和全局容量占位；
- 每项持有独立 `AbortController`；
- 投影 `running` / `cancelling` / `terminalizing`、开始时间和取消时间；
- 向 Runner 提供同步 terminalization fence：栅栏前已接受的取消决定 `interrupted`，栅栏后才到达的取消失败关闭；
- 只在 Runner Promise 完整 settle 后释放容量；
- 在调用 executor 前安装 deferred execution，shutdown fence 新 dispatch、abort 可取消项并等待全部已知执行收敛；
- 默认并发 `1`，硬上限 `8`，不建立内存等待队列。

HTTP server 只负责 loopback/Origin/CSRF/JSON 门禁、WorkItem 存在校验、错误状态映射与安全 projection。Runner 和 Domain 继续拥有持久 Attempt 生命周期。

## 选择理由

- 把并发和取消状态机从 transport 分离，能用纯 application tests 覆盖竞态。
- 不改变 journal schema，旧事件和重启恢复保持兼容。
- 每个运行独立 Abort，允许无关 WorkItem 在显式容量内并行。
- 不把易失 dispatch 状态伪装成持久 Attempt；`202` 语义保持诚实。
- 取消接受与终态选择由同一个同步状态机裁决，HTTP 不根据 `AbortSignal` 猜测持久化是否成功。

## 被拒绝方案

### 继续在 server 内扩展 Map

实现文件更少，但 HTTP、并发、取消和 shutdown 状态继续耦合，难以独立验证和复用，因此不采用。

### 立即增加队列和自动 retry

会引入优先级、持久恢复、退避和公平性问题，超出 T17；留给 T21。

### 修改 Domain 增加 cancel-requested 事件

取消请求是进程控制意图，当前验收只要求 terminal `interrupted` 可复核。提前扩展 canonical schema会增加 replay 兼容成本，因此不采用。

### 让 HTTP 202 等待 durable `attempt.started`

需要拆分 Runner 为 start handle 与 completion handle。当前技术验证只承诺 dispatch accepted，并显式投影 nullable Attempt ID；等远程 API 或 durable queue 需要强确认语义时再升级。

## 影响

正面：

- 可选择、单项取消、有界并行和人工重试形成闭环。
- cancel/retry 不丢 Attempt 历史。
- shutdown 和容量释放共享一个受测状态机。
- late cancel、terminal append failure 与同步 shutdown 重入具有显式失败语义。

限制：

- run phase 重启即丢失；重启恢复仍由 service 把遗留 running Attempt 归一为 interrupted。
- 默认并发 `1`，需要显式配置才会并行。
- 不提供跨进程锁、远程多租户、RBAC 或持久调度队列。

## 回退

删除 coordinator composition 并恢复 server 内单项占位即可；journal、Domain、Provider store 均无需迁移。把并发环境变量移除即可回到默认串行。
