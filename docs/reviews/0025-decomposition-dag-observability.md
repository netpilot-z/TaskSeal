# 审查 0025：可审查的任务分解、DAG 派发与协作可观测性

## 范围

本次审查覆盖 Linear `NP-9`：

- Decomposition Plan v1、preview/approve 与 Runner registry；
- 独立 lifecycle journal、approval generation baseline 与 retirement；
- DAG dispatcher、共享 Attempt coordinator、retry 与所有旁路门禁；
- plan-scoped Acceptance、Evidence、owner/profile 与 replacement semantics；
- HTTP mutation boundary、Control Room 投影、响应式交互与审计；
- 存储原子性、兼容 reader fence、错误映射、测试和文档。

## 独立审查发现

首轮架构、领域和 UI 审查发现：

1. retirement commit 期间，已 ready 的 root 仍可能通过普通 Run 启动；
2. retirement 幂等重试在读取既有记录前校验新时钟，时钟回拨会破坏幂等；
3. approval 与普通 Run 未完全共享线性化 admission；
4. Acceptance 可以采用批准前或错误 owner 执行的 Attempt；
5. replacement plan 会继承旧 Attempt、retry、Evidence 和 rejected 状态；
6. HTTP 对 stale/conflict 与存储不可用的分类不够精确；
7. 退役表单允许空白 audit note，轮询/busy 后焦点恢复不稳定。

第二轮复审又发现：

8. approval 已持有 claim 但 journal 尚未可见时，无 active plan 的 Acceptance
   early return 会绕过 claim；
9. 反向窗口中，无 active plan 的 Acceptance 没有持有 claim，approval 可以并发
   提交并接管正在被接受的 WorkItem。

## 修复与复审

- retirement 为 plan 和全部 owned WorkItem 建立同步 fence；普通 `/run` 通过
  `startManualRun` 在同一调用栈完成 gate 与 coordinator reservation。
- retirement 先读取既有决定，再校验新时间戳；相同命令在时钟回拨后仍返回原记录。
- approval 在任何 `await` 前 claim root/nodes，并检查共享 coordinator、canonical
  running、retirement 和 acceptance claim。
- approval record v2 为 root/nodes 保存 Attempt prefix baseline，envelope v3
  建立明确 reader fence；legacy envelope v1/v2 保持可读且不会只读改写。
- 所有投影和门禁改为 plan generation suffix；Acceptance 绑定 current completed
  Attempt、批准 owner/profile 与 exact decision basis。
- Acceptance 在查询 active plan 前先检查 lifecycle claim，并且无 active plan 时
  也持有全局 WorkItem claim；两个方向均以零回调断言证明失败关闭。
- stale/conflict 映射为 HTTP 409，journal/storage/clock/unknown outcome 映射为
  脱敏 503。
- audit note 在客户端规范化并由服务端 exact 校验；busy、错误和计划消失后焦点
  恢复到原控件或 plan 容器。

最终架构、领域/并发和 UI 复审均未发现新的 P0/P1/P2。

## 验证证据

- 主交付门禁：`npm test` 全量 `872/872` 通过。
- `npm run typecheck` 通过，无 TypeScript 诊断。
- 独立 NP-9 定向复核 `63/63` 通过；dispatcher `22/22` 通过。
- 一次与其他验证并发的独立全量运行有 2 个 Codex 子进程 cleanup 超时；对应
  `codex-app-server-client` 文件隔离重跑 `23/23` 通过。
- dashboard client state `20/20` 通过。
- 浏览器桌面 1280 px 与移动端 375 px 无横向溢出；控制台 0 warning/error；
  活动计划 retirement、audit focus 和轮询草稿保留已完成交互检查。
- `git diff --check`、本地绝对路径扫描和常见凭证模式扫描通过。

## 风险与限制

- 进程内 dispatcher 不是分布式锁；多实例调度必须增加持久 claim/lease 与
  leader/fencing token。
- 显式 tick 不承诺后台队列耐久性，服务重启后需要操作者再次派发。
- baseline 使用 Attempt ID 前缀摘要检测历史漂移，但不会归档或压缩长期历史。
- 当前 UI 只管理已批准计划；计划草案编辑、自动拆 Issue 和跨 Provider 回写属于
  后续里程碑。
- Codex 子进程 cleanup 测试在高并发机器压力下仍可能波动；隔离验证已通过，但
  后续可把进程型测试从纯逻辑测试中分组运行。

## 结论

NP-9 满足技术验证合同，可以进入 PR 与 CI 门禁。TaskSeal 已能把人类批准的 DAG
转化为共享容量内的 Runner 执行，并以 plan-scoped Attempt、Evidence、Acceptance
和不可变 retirement audit 形成可复核闭环。
