# 审查 0014：Provider Operation Journal

## 状态

通过，接受一个明确位于首版威胁模型之外的本地跨进程残余风险。对应 GitHub Issue `#40`；审查对象包括完整历史 replay、单实例 CAS、固定坐标文件存储、崩溃语义、unknown fence、脱敏和后续 transport permit 边界。

## 独立审查范围

两轮独立只读后端审查覆盖：

1. 从 v1 开始的完整 replay、相邻 transition validation 与历史连续性；
2. `expectedVersion + operationKey + planDigest` CAS、exact-latest idempotency 和 competing successor；
3. fixed temporary slot、orphan reuse、directory/temp/target identity 与 whole-file atomic replace；
4. rename 前失败、rename 后不确定、重启恢复和 future transport permit；
5. public error、递归 inspect、路径、payload 与底层异常正文的泄露边界；
6. storage coordinate、workspace escape 与 pathname-based rename 的威胁边界。

## Finding 与闭环

### 相邻合法 snapshot 仍可能组成非法历史

只逐条 parse 会接受分别合法、但在相邻版本间篡改 approval actor、plan、createdAt 或既有审计字段的历史。Journal replay 现从 v1 开始逐对调用 #39 的唯一 pair validator，并拒绝缺口、重复和跳号。

### 最终检查与 rename 分离可误报 committed

早期实现的异步最终检查与 rename 之间存在可注入窗口，目录或 target 替换后可能误报 committed，并让未来 coordinator 错误发放 transport permit。

现固定 storage 坐标，保存 bigint directory/temp/target identity，在无 JS await 的同步最终检查后立即 `renameSync`，再对原 directory 和新 target identity 做对账。任何 rename 后无法确认均返回 `COMMIT_OUTCOME_UNKNOWN` 并 fence 当前实例；定向 race 测试覆盖 pre-rename swap、post-rename target swap 和崩溃重启。

### 底层 Error.cause 会重新泄露敏感正文

只把顶层错误消息替换为固定文本仍不足够；Node 的递归 inspect 会沿 `Error.cause` 输出临时路径或底层 sentinel。Public journal error 现只保留固定 code/message，不附带底层 cause，并用对抗性 inspect 回归验证。

### 可配置 file path 扩大写入坐标

早期 storage 构造参数允许调用者把同一层级的任意文件作为 target，例如仓库元数据。构造器现只接受 workspace root，并在内部固定推导 `.taskseal/provider-operations.json`；回归测试确认额外运行时参数不能改写 `.git/config` 等其他文件。

### 崩溃遗留 temporary 阻塞自动恢复

固定 `wx` slot 在 rename 前崩溃后会留下 orphan。现仅在 directory identity、lstat/open identity、single-link 和 0600 权限均通过时原位 truncate/reuse；不按路径删除，异常或被替换的 temp 继续失败关闭。

## 接受的威胁边界

Node 内置 pathname API 不能把最后一次目录 identity 检查和 `rename` syscall 原子绑定。同权限恶意 OS 进程仍可能在两个 syscall 之间替换 `.taskseal`，从而在 workspace 外产生 rename/覆盖副作用。后置复核会把结果转为 unknown/fence，因此不会误报 committed 或授权后续 transport，但无法撤销已经发生的文件系统副作用。

首版明确要求可信本地单 writer，且 TaskSeal 不以高于 workspace owner 的权限运行，因此该主动攻击不作为 #40 blocker。若未来需要防御不可信本地进程，应使用 owner-only OS ACL 加目录句柄相对的 native `openat/renameat`、SQLite 或独立单写服务；继续叠加 pathname 检查不能彻底解决。

## 架构边界

- Journal 独立于 canonical workflow journal 与 Provider Observation。
- application 层拥有 replay、CAS 与 reopen fence；storage 不解释 transport 语义。
- 只有本次 `submitting` append 返回 `committed` 才可能成为一次 transport permit；`idempotent`、write failed、unknown 或 reopen-required 均不能授权。
- 查询和命令每次 fresh load/replay；首版 promise queue 只提供单实例 serialization，不是多进程 CAS。
- 本切片没有 runtime、CLI/HTTP、网络、凭证或真实 Provider mutation。

## 验证证据

- Operation Journal application/storage/crash 定向测试：38/38 通过。
- `npm run typecheck`：通过。
- `npm test`：382/382 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过。
- 生产依赖：0。
- 两轮独立后端复审确认原 false-committed/future-permit 和 `Error.cause` finding 已闭环；跨进程 syscall TOCTOU 已按上述边界接受并记录。

## 剩余风险

- 同等本地文件权限的恶意跨进程目录替换不在首版强隔离保证内。
- 多实例同时写入可能 lost update；需要单写服务、数据库事务或平台锁。
- 完整合法 suffix 删除无法仅靠 replay 检出；首版没有 hash chain、签名或远端审计副本。
- fake Linear transport、coordinator、operation projection 和真实写前专用 probe 尚未实现。

## 结论

#40 在可信单实例边界内建立了可重放、可审计且不会把不确定提交误作 transport permit 的本地 Operation Journal。可以进入 #41 的 fake Linear create/query transport 合同；真实 mutation 仍未授权。
