# 审查 0016：受控写入 Coordinator

## 状态

通过。对应 GitHub Issue `#42`；初审发现的时钟错误边界和安全验收测试缺口已修复，复审未发现剩余 P0–P3 可执行问题。

## 独立审查范围

审查覆盖：

1. application 状态机、journal ports、transport port 与 connector/storage 的依赖方向；
2. per-operation queue、fresh latest、CAS append 与 promise tail ownership；
3. submitting/reconciling committed permit 和零盲重试边界；
4. approval、operation key、plan digest、payload 与 resolved scope binding；
5. transport throw、malformed result、identity mismatch 与安全分类；
6. result persistence failure、commit outcome unknown、全实例 fence 与 reopen recovery；
7. clock、journal、transport 异常的固定错误和脱敏；
8. 不同 operation 并行、批量 interrupted recovery 与只读 #29 投影边界。

## 审查结论

### 所有权与依赖

`ControlledWriteCoordinator` 位于 application 层，只依赖受控写状态机、`ProviderOperationJournal` command/query ports、`LinearWriteTransportPort` 与注入 clock。GraphQL、fake、文件存储、endpoint 和 global fetch 都不进入 coordinator。

状态与 transition 不变量继续由 `controlled-write-operation.ts` 单点拥有；journal 负责 version replay/CAS，transport 负责 Linear-specific request/result contract，coordinator 只拥有 saga 顺序和 permit。#29 应继续直接依赖 journal query port，不依赖 coordinator 或文件 envelope。

### Permit、队列与恢复

- 同 operation 的完整“fresh read → begin append → transport → result append”由 per-key promise tail 串行。
- 只有本次 begin append 返回 `committed` 才调用 transport；known failure、idempotent 与 commit unknown 都是零调用。
- 不同 operation 可并行进入 transport，底层 journal 仍串行执行 whole-file CAS。
- transport 后投影或 result append 任意失败都会 fence 整个 coordinator 实例。
- reopen 只把遗留 submitting/reconciling 投影为本地安全状态，不调用 create/query。
- 批量 recovery 中途失败时 `open()` 不返回部分可用实例；下次 reopen 可以按已持久事实继续收敛。

### 命令返回与 found 状态

维持“返回当前已持久化完整 Operation”，不新增第二份 command receipt。它已包含安全 Issue identity，并让 retry 返回 canonical latest；未来 HTTP/CLI 若确需区分 committed/idempotent，可在 adapter 层增加非持久化 envelope。

Issue #42 的“found 收敛 created”按业务结果解释为确认同一个逻辑 Issue；持久状态仍使用 #39 已接受的 `reconciled`，不增加多余的 `reconciled → created` transition。

## 审查后修复与补强

### P2：hostile clock error

初审确认 clock 返回的 `Date` 可覆盖 `getTime()` / `toISOString()` 并把异常原文越过公共错误边界。现已把 clock 调用、native time value 读取与 ISO 转换放入同一保护区，并通过 `Date.prototype.*.call` 避免实例方法劫持；任意失败统一为固定 `CONTROLLED_WRITE_COORDINATOR_CLOCK_INVALID`。

### P2：安全验收矩阵

初审指出 permit、classification、fence 与异常脱敏的若干静态路径缺少直接回归。现已补充：

- submitting known failure 的零 create 与健康重试；
- reconciling known/idempotent/unknown 的零 query；
- reconciliation result append failure 的全实例 fence；
- malformed create/query 与 ID/Team mismatch 的 unknown/failed/ambiguous 分类；
- 不同 operation 并行和旧 queue tail identity；
- wall-clock regression clamp、completion clock fallback 与 arbitrary journal error 脱敏。

### P3：并行与批量恢复声明

架构初审建议直接证明不同 operation transport 并行，以及多条 interrupted operation 的中途 recovery failure。两项回归均已加入；failure 时 transport 为零、`open()` 拒绝返回实例，下一次 reopen 按 journal 事实合法收敛。

## 验证证据

- Controlled Write Coordinator 定向测试：33/33 通过。
- `npm run typecheck`：通过。
- `npm test`：455/455 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过。
- 生产依赖：0。
- 独立后端复审：无剩余 P0–P3。
- 独立架构复审：无剩余 P0–P3。

## 剩余风险

- 当前最多一次 permit 只适用于可信单进程、单 coordinator 实例；多进程强一致需要独立单写服务或事务型存储。
- fake response-lost 只证明 client UUID correlation 流程，不证明真实 Linear 的可见性延迟、权限、rate limit 或 schema 稳定性。
- journal commit unknown 与 Provider outcome unknown 只能 fence 和显式对账，不能宣称外部 exactly-once。
- 当前没有 CLI/HTTP 审批入口、真实 credential、真实 mutation、RBAC 或无人值守 retry。

## 结论

#42 已在 fake 边界内建立可审计的一次 permit、未知结果 fence、显式 UUID 对账和重启恢复闭环。可以进入 #29，以独立 journal query port 投影安全 operation 状态；真实 Linear mutation 继续保持关闭。
