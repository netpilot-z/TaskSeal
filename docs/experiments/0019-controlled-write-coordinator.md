# 实验 0019：受控 Linear 写入 Coordinator

## 实验卡

- 决策：把 #39 状态机、#40 Operation Journal 和 #41 fake transport 组合后，能否证明一次 committed submitting permit、崩溃恢复与显式对账闭环。
- 假设：per-operation coordinator queue 覆盖“读 latest→append→transport→append”，并只把本次 committed begin transition 当作 permit，可以在不依赖真实 Provider 幂等的情况下阻止盲目重复 create。
- 反证：rejected/未审批仍调用 transport；并发 submit 调用两次 create；idempotent/unknown append 仍发 permit；response lost 后重试 create；result append failure 后旧实例继续服务；restart 重放 create/query；absent 自动循环。
- 指标：coordinator 定向测试、全量测试、类型检查、生产依赖、diff 检查与独立后端/架构审查。
- 边界：只有 injectable fake；没有 global fetch、真实 credential/endpoint、CLI/HTTP、浏览器审批、多租户或真实 Linear mutation。

## Red

先新增 coordinator 集成测试；测试因 `controlled-write-coordinator.ts` 不存在而以 `ERR_MODULE_NOT_FOUND` 失败。Red 固定：

1. prepare/approve/reject 的持久 history 与 binding；
2. 同 operation concurrent submit 的一次 create permit；
3. created、not-dispatched 与 response-lost unknown；
4. found、absent、failed 与 ambiguous reconciliation；
5. journal committed/idempotent/unknown 对 transport call 的门禁；
6. result append failure 的 coordinator fence；
7. memory/file-backed restart recovery；
8. transport exception 与 clock failure 脱敏。

## Green

- coordinator 只依赖 application ports、纯状态机与 clock，不导入 connector/storage。
- 每个 operation 的 promise tail 覆盖完整 command；journal 继续负责单次 CAS 和 file atomicity。
- identical prepare/repeated approval/terminal submit 返回 persisted latest；payload/scope/actor/digest drift 失败关闭。
- rejected submit 0 calls；same-operation concurrent submit 只有一个 create。
- 只有 committed v3 append 调用 create；idempotent 与 commit-unknown v3 append 都是 0 calls。
- fake response lost 先创建 Issue，再由 v5 query 按 client UUID found，v6 持久为 reconciled；create count 始终 1。
- not-dispatched 持久为 terminal failed，fake external write count 0。
- absent v6 不产生后台调用；下一次显式 reconcile 才生成 v7/v8。
- query HTTP failure 与 ambiguous correlation 分别保存 failed/ambiguous safe diagnostic，并保持 outcome unknown。
- transport 后 created append 的已知 failure fence旧 coordinator；reopen 将 v3 转 unknown，随后 query fake store found，不产生第二次 create。
- file-backed reopen 把 leftover submitting 与 reconciling 分别转 unknown/failed，transport count 保持 0。
- 任意 transport exception 只保存 `LINEAR_WRITE_OUTCOME_UNKNOWN` / `LINEAR_RECONCILIATION_FAILED`，不保存错误正文。
- permit 前 clock invalid 保持 approved 且 transport 0 calls；completion clock 可退回 current timestamp。
- native `Date` 调用失败统一为固定 clock error；wall-clock 回退 clamp、completion clock fallback 均有直接回归。
- submitting/reconciling 的 known failure、idempotent 与 commit-unknown 门禁均有对称测试；只有 committed begin transition 产生外部调用。
- 不同 operation 可同时进入 transport；同 operation 的旧 queue tail 不能误删后继命令。
- 多条 interrupted operation 的批量 recovery 在中途失败时拒绝开放；再次 reopen 能以零 transport 收敛全部遗留状态。
- malformed/correlation mismatch transport result、arbitrary journal error 和 reconciliation result persistence failure 均失败关闭且不泄露原文。

## 验证证据

- Controlled Write Coordinator 定向测试：33/33 通过。
- `npm run typecheck`：通过。
- `npm test`：455/455 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过。
- 生产依赖：0。
- 独立后端与架构复审：无剩余 P0–P3。

## 结论

实验当前支持假设。#42 已在 fake 边界内跑通从人工审批到一次提交、未知 fence 和 client UUID 对账的完整闭环；这证明的是可审计 permit/saga，不是 Linear exactly-once。下一步 #29 只通过 journal query port 投影安全 operation 状态；任何真实 Linear mutation 仍需专用 schema/permission probe 与新的明确授权。
