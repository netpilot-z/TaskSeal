# 规格 0019：Control Room 执行控制

## 状态

已实现。对应 Linear `NP-5` / T17。

## 目标

让本地 Control Room 可以显式选择 WorkItem，安全派发、取消和重试 Codex Attempt，并在单进程边界内提供可配置的有界并发。

## 术语

- **dispatch**：Control Room 已在当前进程中占用一个运行槽位，并把请求交给 Runner。
- **Attempt**：Runner 通过 canonical event journal 持久化的执行历史。
- **run phase**：进程内运行协调状态，包含 `running`、`cancelling` 或 `terminalizing`。`terminalizing` 表示终态已经选定并正在持久化。
- **owner**：当前或最近 Attempt 的 `agentId`。本切片不把 Linear assignee 引入 WorkItem 领域模型。

HTTP `202` 表示 dispatch 已接受，不承诺 `attempt.started` 已经落盘。Runner 可能仍在校验 cwd；此时 `runtime.runs[].attemptId` 为 `null`。持久化事实仍以 WorkItem 的 `attempts[]` 为准。

## 行为合同

### 任务选择

- 前端使用原生选择控件和每张 WorkItem 卡片上的原生按钮选择任务。
- dashboard 轮询和 WorkItem 排序变化不得重置仍然存在的选择。
- 选中项消失时才回退到当前第一项；无 WorkItem 时选择为 `null`。
- 卡片用文字、`aria-pressed`、边框和可见 focus 同时表达选择，不只依赖颜色。

### 派发与有界并发

- `POST /api/work-items/:id/run` 保持原请求合同。
- 同一 WorkItem 同时只能有一个运行，冲突返回 `409 ATTEMPT_ALREADY_ACTIVE`。
- 不同 WorkItem 可在 `maxConcurrentRuns` 内并行。
- `TASKSEAL_MAX_CONCURRENT_RUNS` 可配置 `1`～`8`，默认 `1`；非法值在初始化和监听端口前失败。
- 达到容量后不排队、不调用 Runner，返回 `429 RUN_CAPACITY_REACHED`。
- 默认串行只代表容量策略；任务选择、查看和单项取消不会被其他任务全局锁死。显式把容量设为 `2`～`8` 后，无关任务可同时运行。

### 取消

- `POST /api/work-items/:id/cancel` 只接受 loopback、same-origin、当前 CSRF token、`application/json` 和空 JSON 对象。
- 取消只触发目标 WorkItem 的 `AbortController`；其他运行不受影响。
- 首次取消把 run phase 改为 `cancelling`；已接受取消后，在同一执行尚未 settle 时重复取消幂等返回 `202`。
- `cancelling` 继续占用容量，直到 Runner Promise 完整 settle，包括 `attempt.finished` journal append。
- Runner 在选择终态和写入 `attempt.finished` 之间同步进入 `terminalizing` 栅栏：栅栏前已接受的取消必须选择 `interrupted`；未曾取消且栅栏后到达的取消返回 `409 RUN_TERMINALIZING`，不得把已选终态改写。
- settle 后再次取消返回 `409 RUN_NOT_ACTIVE`。
- 成功持久化的操作者取消不进入通用 runtime error；Runner 以 `interrupted` Attempt 记录可复核终态。终态 journal 写入、service fence 或未知执行错误必须进入安全的 `runtime.errors`，不得只因 signal 已 abort 而忽略。

### 重试与历史

- 不新增自动 retry 或专用 `/retry` route。
- terminal Attempt 后再次调用 run 即为人工重试；Runner 必须生成新 Attempt ID。
- 旧 Attempt 不删除、不改写；新 Attempt 成为 active Attempt。
- UI 对已有历史且当前非活跃的 WorkItem 显示 `Retry Codex`，并展示 Attempt ID、owner、状态和终态时间。

### 状态投影

Persistent dashboard 保留 `runtime.activeWorkItemIds`，并新增：

```json
{
  "capacity": {
    "maxConcurrentRuns": 2,
    "activeCount": 1,
    "availableSlots": 1
  },
  "runs": [
    {
      "workItemId": "TS-1",
      "phase": "running",
      "attemptId": null,
      "startedAt": "2026-07-28T09:00:00.000Z",
      "cancelRequestedAt": null
    }
  ]
}
```

`runtime.runs` 是易失的进程状态；`workItems[].attempts` 是重启后可重放的审计历史。

## 失败与竞态边界

- admission check 与 Map 占位同步完成，中间没有 `await`。
- coordinator 在调用可注入 executor 前先安装 deferred execution；executor 即使同步重入 shutdown，也不能让 shutdown 提前完成。
- terminalization decision 与 cancel 在同一 coordinator 状态机内同步串行，消除“取消返回已接受、最终却写成 completed”的竞态。
- 容量只在执行完整 settle 后释放。
- cleanup 使用 entry identity，旧运行不得删除新的重试 entry。
- shutdown 先停止接单，再逐项 abort，并等待所有已知 execution settle。
- 多 Control Room 进程共享 journal 的强一致并发不在本切片范围；当前只保证单进程协调。
- 不提供等待队列、优先级、自动退避或 DAG 调度；这些属于 T21。

## 验收

1. 选择在轮询和重排后保持，删除后安全回退。
2. limit `2` 时两个无关 WorkItem 并行，第三个不调用 Runner并返回容量错误。
3. cancel 只中断目标；已接受取消最终写成 `interrupted`，晚于终态栅栏的取消明确失败。
4. interrupted 后 retry 产生不同 Attempt ID，旧历史保留。
5. cancel 与 run 使用相同的本地写安全门禁。
6. 键盘选择、focus、375px 移动布局和按钮触控尺寸通过浏览器检查。
7. 取消期间终态写入失败会投影安全 runtime error；shutdown 同步重入仍等待执行 settle。
