# 实验 0017：Provider Operation Journal

## 实验卡

- 决策：能否用零生产依赖的本地文件，在真实 Provider transport 之前证明受控写 Operation 的完整 version replay、单实例 CAS、崩溃完整性和 unknown fence。
- 假设：application-owned replay/CAS 加上 bounded whole-file atomic replace，足以让后续 coordinator 只把本次 committed 的 `submitting` 当作一次 transport permit 前置证据。
- 反证：独立合法但相邻篡改的 snapshot 被接受；exact retry 再次 committed；两个并发 submitting 都 committed；stale retry 被误报 idempotent；rename 前破坏旧权威；rename 后仍继续服务；文件增长、target swap 或 Junction 逃逸边界。
- 指标：application/storage/crash 定向测试、全量测试、类型检查、生产依赖、diff 检查和独立后端审查。
- 边界：不接 transport、coordinator、CLI、HTTP、Control Room 或真实 Linear；只信任本地单 writer，不承诺多进程 CAS、密码学 append-only、自动 orphan cleanup，或抵御同权限恶意 OS 进程的 syscall 级目录替换。

## Red

第一组测试先因 application journal 模块缺失失败，覆盖：

1. 从 v1 开始的完整 replay 与相邻 pair validation；
2. `expectedVersion + operationKey + planDigest` CAS；
3. exact latest idempotency、stale retry 和 competing successor；
4. rename 后 unknown 的全实例 fence。

第二组测试先因 file storage 模块缺失失败，覆盖：

1. bounded read 与 16 MiB / 512 records 硬边界；
2. directory/target identity、symlink/Junction 和 hardlink swap；
3. fixed `wx` temporary slot、file sync、atomic rename；
4. rename 前/后 injected failure 与真实子进程退出。

实现过程中还收敛了两个语义：

- 触发 rename 后故障的 compare-and-append 保留 `COMMIT_OUTCOME_UNKNOWN`；只有后续调用返回 `REOPEN_REQUIRED`，使未来 coordinator 明确不能发放 transport permit。
- rename 前 orphan temp 不会被路径清理；旧 target 仍权威。合法 single-link temp 可在目录与 lstat/open identity 复核后原位 truncate/reuse，异常 temp 仍需人工处理。

## Green

- `ProviderOperationJournal` 在 open/query/command 时 fresh load，逐条 parse，并从 v1 开始逐对调用 #39 的唯一 pair validator。
- 文件按 operation key/version 规范排序，拒绝缺 v1、重复/跳跃 version、plan/actor/时间/既有审计字段漂移。
- 新 operation 只接受 expected v0 + next v1；successor 必须 exact CAS 并通过状态机。
- exact current snapshot retry 返回 idempotent 且零 replace；operation 已推进后重试旧 snapshot 返回 version conflict。
- 同一实例 promise queue 让相同 submitting 并发结果固定为一个 committed、一个 idempotent；不同 successor 只有一个可提交。
- query 每次重新加载完整 atomic snapshot，返回深度冻结 operation 与冻结数组。
- storage 只接受 workspace root 并固定推导 `.taskseal/provider-operations.json`；复核 realpath/device/inode、target lstat/open identity，并读取 `limit + 1`。
- replace 使用唯一 0600 temp，执行 write → file sync/capture identity → 同步 pre-rename identity checks → rename → post-rename directory/target identity recheck → best-effort directory sync。
- rename 前失败保留旧 target；rename 后失败返回 outcome unknown 并 fence；重启只看到旧或新完整 snapshot。
- 可确定注入的 pre-rename directory swap 不能返回 committed 或改写 replacement target；post-rename target swap 会返回 outcome unknown 并 fence。
- public journal error 只有固定 code/message，递归 inspect 不会重新暴露 storage cause、临时 workspace 路径或 sentinel 正文。
- 512 records 满载后第 513 条失败关闭，不淘汰既有历史。

## 崩溃证据

- 子进程在 temp sync 后、rename 前退出：重启得到 empty/旧 journal，只有一个 orphan temp。
- 子进程在 rename 后退出：重启得到一条完整 v1 record，没有 partial JSON。
- 重启读到遗留 submitting 时只返回该事实，不自动 replace、提交或生成新的 permit。

## 验证证据

- Operation Journal application/storage/crash 定向测试：38/38 通过。
- `npm run typecheck`：通过。
- `npm test`：382/382 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过。
- 生产依赖：0。
- 两轮独立后端复审确认 false-committed/future-permit 与 `Error.cause` 泄露已闭环；另记录一个不在首版威胁模型内的跨进程 syscall TOCTOU 残余风险。

## 结论

支持实验假设。#40 已证明可信单实例本地 Operation Journal 可以作为后续一次 transport permit 的持久前置边界，同时诚实保留 unknown、orphan、多进程限制，以及 pathname rename 对恶意跨进程替换不能保证零越界副作用的边界。下一步 `#41` 只实现 realistic fake Linear create/query transport；真实 mutation 仍未授权。
