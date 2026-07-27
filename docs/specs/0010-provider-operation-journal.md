# 规格 0010：Provider Operation Journal

## 目标

为受控外部写 Operation 提供一个独立、有界、可重放、原子替换且支持单实例 compare-and-append 的本地 journal，使后续 coordinator 只有在 `submitting` version 确定持久化后才可能获得一次 transport call permit。

本规格对应 GitHub Issue `#40`。它只实现 application journal 与 file storage，不接 Linear transport、CLI、HTTP、Control Room 或真实 mutation。

## 所有权与依赖

```text
future coordinator (#42)
  → ProviderOperationJournal command/query ports
    → controlled-write Operation parser + pair validator
      → ProviderOperationJournalStoragePort
        → .taskseal/provider-operations.json
```

- Operation Journal 独立于 `.taskseal/events.jsonl` 和 `provider-observations.json`。
- application 层拥有 envelope、replay、CAS、查询和 reopen fence。
- storage 层只负责 bounded load 与 whole-file atomic replace，不解释 coordinator 语义。
- `#29` 后续只依赖 query port，不读取文件 envelope。

## 持久格式 v1

```text
schemaVersion: 1
records:
  - ControlledWriteOperation v1
  - ...
```

固定边界：

- 文件最多 16 MiB；
- records 最多 512；
- envelope、array 与每个 record 均严格 runtime 校验；
- 不淘汰、不压缩、不覆盖历史 version，达到边界时失败关闭；
- 规范持久顺序为 `operationKey` 升序、同 operation 内 `version` 升序。

每个 record 是完整 Operation snapshot。文件不保存 action、Token、headers、URL、raw Provider body、错误正文或 stack。

首版保证结构、状态转换和原子完整性，不提供密码学 append-only 证明。拥有本地文件写权限的操作者若删除一个完整合法 suffix 或整个 operation，单靠 replay 无法检测；本切片不提前增加 hash chain、签名或远端审计副本。

## Replay

每次 open、query 和 command 的 fresh load 都必须完整 replay：

1. envelope exact-key 且 schema v1；
2. records 是普通、稠密、无附加字段的 array；
3. 每条调用 `parseControlledWriteOperation`；
4. 按 operation key 分组并按 version 排序；
5. 拒绝重复 `(operationKey, version)`；
6. 每组第一条必须是 v1 `approval_required`；
7. 后续必须连续无缺口，并逐对调用 `validateControlledWriteOperationTransition`。

不能只检查单条 record、version 连续或相同 digest；否则会接受 independently valid、但修改 approval actor、plan、createdAt 或既有审计字段的相邻 snapshot。

## Command port

```text
compareAndAppend({
  expectedVersion,
  operationKey,
  planDigest,
  next
})
  → committed | idempotent
```

规则：

1. input exact-key；`expectedVersion` 是 0 或正 safe integer。
2. `operationKey/planDigest` 必须等于 `next.plan`。
3. 新 operation 只接受 `expectedVersion=0` 与 v1。
4. 已有 operation 先校验相同 operation key 下的 plan digest。
5. 若 current latest 与 next canonical exact equal，且 `expectedVersion + 1 === next.version`，返回 `idempotent`，不 replace。
6. 已推进到更高 version 后重试旧 next 不是 idempotent，必须 version conflict。
7. 新 successor 要求 current version 等于 expected version、next version 等于 expected version `+1`，并通过 pair validator。
8. 同实例所有 command 进入同一 promise queue；candidate 生成和 replace 属于一个 critical section。
9. replace 成功才返回 `committed`。

对后续 `#42` 的硬合同：只有本次 `begin_submission` append 返回 `committed` 时，调用者才可能消费 transport permit；`idempotent` 永远不能再次授权 transport。

## Query port

- `get(operationKey)`：返回 latest 或 null；
- `history(operationKey)`：返回完整连续历史；
- `listLatest()`：按 operation key 返回所有 latest。

query 等待当前实例 write queue，然后 fresh load/replay，使另一个已完成 atomic replace 的实例在下次查询可见。返回的 operation 与数组均不可变。

## 原子写与故障

文件固定为 `.taskseal/provider-operations.json`，唯一 temporary slot 为 `.taskseal/.provider-operations.json.tmp`。storage 构造器只接受 workspace root 并自行推导该坐标，不接受可配置 file path。

storage 必须：

1. 要求目标位于 workspace 的一个直接 state directory；
2. 拒绝逃逸 workspace 的 symlink/Junction；
3. 记录并复核 directory realpath、device 与 inode；
4. 对目标执行 lstat/open 后 identity 对账；
5. 读取 `limit + 1`，不能只相信 stat size；
6. 以 `wx`、0600 创建唯一 temp；若存在合法 orphan，只能在 lstat/open identity、single-link、目录 identity 与 0600 权限复核后原位 truncate/reuse，不能按路径删除；
7. write → file sync，并记录 temp 的 bigint device/inode 与 single-link identity；
8. rename 前同步复核 directory/temp/target identity，随后无 JS await 地执行 rename；
9. rename 后再次复核原 directory identity，并用 lstat/open 对账 target 正是已 sync 的 temp identity；
10. identity 全部一致后才做 best-effort directory sync 并允许返回 committed。

故障语义：

- rename 前失败：旧 target 仍权威，返回 write failed；保留至多一个有界 temp slot，不能用路径清理追随被替换的 directory。后续调用可以在上述 identity/single-link 检查后安全复用合法 orphan；非法或被替换的 temp 继续失败关闭并需要人工处理。
- rename 后失败或无法确认：触发本次 compare-and-append 返回 commit outcome unknown，且不能授予 transport permit；application journal 同时进入 reopen-required，当前实例后续 query/command 均失败关闭。不能把首次 unknown 折叠成普通 write failure 或 idempotent。
- public journal error 只包含固定 code/message，不保留原始 `Error.cause`；日志器不能借递归 inspect 重新输出路径、payload 或底层异常正文。
- reopen 只读取完整 target。若最后事实是 `submitting`，未来 coordinator 必须转为 unknown/reconcile，不能重放 create。

## 并发边界

首版只保证一个 TaskSeal/Control Room 实例内的 writer serialization。atomic rename 不是跨进程 CAS；不得把本规格描述为 exactly-once 或多进程安全。TaskSeal 不应以高于 workspace owner 的权限运行，`.taskseal` 必须属于可信本地单 writer 边界。

Node path API 无法提供跨平台 `renameat/openat`。同步 rename 前检查与 rename 后 identity 对账用于防止 false committed：发现替换后返回 unknown 并 fence，不能继续授权 transport；它不能保证同等权限的恶意 OS 进程在最终检查与 `rename` syscall 之间替换目录时不会产生 workspace 外的文件系统副作用。该主动攻击者不在首版威胁模型内。若要把“不逃逸 workspace”提升为不可信本地进程下的强安全边界，必须采用 owner-only OS ACL 加目录句柄相对的 native `openat/renameat`、SQLite 或独立单写服务；继续叠加 pathname 检查不能彻底封闭该窗口。多进程/远程 writer 同样需要数据库事务或平台锁决策。

## 错误码

- `PROVIDER_OPERATION_JOURNAL_INVALID`
- `PROVIDER_OPERATION_JOURNAL_STORE_CORRUPT`
- `PROVIDER_OPERATION_JOURNAL_VERSION_CONFLICT`
- `PROVIDER_OPERATION_JOURNAL_PLAN_CONFLICT`
- `PROVIDER_OPERATION_JOURNAL_LIMIT_EXCEEDED`
- `PROVIDER_OPERATION_JOURNAL_READ_FAILED`
- `PROVIDER_OPERATION_JOURNAL_WRITE_FAILED`
- `PROVIDER_OPERATION_JOURNAL_COMMIT_OUTCOME_UNKNOWN`
- `PROVIDER_OPERATION_JOURNAL_REOPEN_REQUIRED`

错误消息固定且不回显 record、payload、路径或底层异常正文。

## 验收

1. empty、单 operation、所有合法终态/对账路径和多 operation 可以确定性 reopen/replay。
2. 缺 v1、重复/跳跃 version、plan 漂移和相邻审计篡改失败关闭。
3. initial append、normal successor、exact latest retry、stale retry 与并发 successor 符合 CAS 规则。
4. 只有一个并发 submitting append 返回 committed；另一个是 idempotent 或 conflict。
5. rename 前保持旧文件；rename 后 unknown fence，reopen 看到完整 candidate。
6. oversized、增长竞态以及可确定注入的 target/state-directory swap 均失败关闭；同权限恶意跨进程 syscall 竞态遵循上述显式威胁边界。
7. 生产依赖保持为 0；没有网络、CLI/HTTP 或真实 Provider 写入。
