# 实验 0027：Control Room 执行控制

## 假设

不修改 canonical event schema，只增加 application-owned coordinator 和前端选择状态，就能验证 T17 的选择、取消、有界并发、per-run 状态和新 Attempt 重试。

## 反证条件

- 不同 WorkItem 绕过容量上限。
- cancel 误伤其他 WorkItem，或取消后立即释放容量而 terminal journal 尚未写完。
- dashboard 轮询把操作者选择重置到第一项。
- 任意 active run 继续全局禁用无关任务，即使仍有容量。
- retry 覆盖旧 Attempt，或复用旧 Attempt ID。
- cancel route 绕过现有本地写安全门禁。
- cancel 已返回接受，但被阻塞的 terminal append 最终仍写成 `completed`。
- signal abort 掩盖 terminal journal 写入失败，或同步 executor 让 shutdown 提前返回。

## TDD 过程

1. 新 coordinator 测试首先因模块不存在失败。
2. server 测试首先观察到第三个不同 WorkItem 仍返回 `202`，cancel route 返回 `404`。
3. dashboard client-state 测试首先因选择/control model export 不存在失败。
4. 分别补最小 coordinator、HTTP composition 和纯 UI state helper。
5. 增加真实 `TaskSealService + CodexRunner` 回归，验证 interrupted 后 retry 保留两条不同 Attempt。
6. 独立审查构造 terminal append 与 shutdown 重入竞态，先得到失败复现，再加入 terminalization fence、deferred execution 和持久化错误回归。

## 已验证行为

- limit `2` 时两个不同 WorkItem 同时进入运行，第三个 `429` 且零 Runner 调用。
- 同一 WorkItem 的并发 start 只有一个成功。
- cancel 只 abort 目标，重复 cancel 在 settle 前幂等。
- `cancelling` 继续占用容量；settle 后新 dispatch 可使用释放槽位。
- shutdown abort 全部运行并等待 terminal work。
- selection 跨轮询/重排保持，消失后才回退。
- 有剩余容量时，无关 active run 不禁用选中任务。
- terminal 历史使按钮显示 Retry；实际 retry 生成新 ID，旧 interrupted Attempt 保留。
- cancel 的 JSON、Origin 与 CSRF 反例均失败关闭。
- cancel 在 terminalization 前被接受时，即使 client 忽略 abort 并返回 completed，最终仍持久化 interrupted。
- terminal append 已开始后才到达的 cancel 返回 `RUN_TERMINALIZING`，既不伪装接受也不改写已选终态。
- interrupted terminal append 失败会保留 `JOURNAL_WRITE_FAILED` 等安全 code 到 runtime projection。
- executor 同步重入 shutdown 时，shutdown 等待预先登记的 execution settle。

## 结论

技术假设成立。T17 不需要修改 Domain 或引入 NestJS、队列和新依赖。下一阶段 T18 可以在稳定 WorkItem/Attempt 映射上自动收集 GitHub Artifact 与 Evidence。
