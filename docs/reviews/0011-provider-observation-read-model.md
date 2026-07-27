# 审查 0011：Provider Observation 读模型与只读 API

## 状态

通过。对应 GitHub Issue `#23`；审查对象包括 observation 领域规则、bounded atomic storage、inspection/import coordinator、真实 snapshot preview/apply façade、CLI/runtime composition、`GET /api/providers` 与相关文档。

## 独立审查范围

进行了两个独立只读 pass，并在修复后重复复审：

1. 后端与架构 pass：identity、新鲜度、scope reconciliation、真实 application caller、preview/apply 事务边界、运行时配置一致性、API 契约与回归兼容性。
2. 安全与持久化 pass：字段裁剪、错误泄露、runtime object safety、严格时间、路径约束、Junction/symlink、文件 identity、bounded read、atomic replace、失败清理与资源上限。

## Finding 与闭环

### Scope 与真实 application composition

- observed scope 曾可从 configured target 复制，可能把错误响应伪装为成功；现由受验证结果投影并精确对账。
- observation 曾只包裹测试回调，没有真实 preview/apply 入口；现由 `ObservedSnapshotImportFacade` 组合原有纯 preview 与 `TaskSealService` apply port。
- façade 曾在真实 service 之后才暴露跨 Provider/foreign Team 计划；现以 descriptor-safe preflight 在读取 policy 前拒绝跨 Provider snapshot，并在 service 前对规范化 plan 做 provider + exact bound scope 校验。
- Linear 曾仅凭 UUID 形状建立配置引用到 resolved scope 的信任；现要求同一配置快照或已有 `snapshot_ready` observation 提供显式 binding。
- 合法大写 A–F UUID 虽能被 import 规范化，曾会在 observation 中误报 `scope_mismatch`；现使用真实 plan 的 canonical `policyBinding.scopeRef` 投影，并验证重启后仍能恢复 façade binding。

### 新鲜度与 runtime data

- 等价 RFC 3339 offset 曾因文本不同产生同版本冲突；现先严格校验日历与格式，再统一 UTC 后参与 freshness 和 digest。
- 宽松 `Date.parse` 曾接受非 RFC 文本；现仅接受明确 RFC 3339 语法。
- 自定义数组原型曾可能在遍历或 canonicalization 时执行外部代码；现只接受标准 dense array，并拒绝 accessor、稀疏或自定义原型。

### 文件系统与资源边界

- 状态目录 Junction 可把写入重定向出工作区；现捕获 canonical path、device/inode，并在读取和 rename 前持续复核目录 identity。
- `stat` 后直接读取曾可被并发增长绕过上限；现使用最多 `256 KiB + 1` 的 bounded loop。
- 读取目标曾可能在 `lstat` 后被替换；现比较已打开 handle 与已验证目标的 device/inode。
- rename 前失败后的 path-based cleanup 曾可在目录被换成外部 Junction 后删除同名文件；现失败路径不执行字符串 path unlink。
- 移除 cleanup 后，随机 temporary file 曾可能随重试无界累积；现使用单一确定性 `wx` slot，残留最多一个 mode 0600、最大 256 KiB 的文件，后续写入失败关闭。

最终后端复审与安全复审均未发现剩余 P0–P3。

## 架构边界

- observation 是可替换的运行读模型，不是 canonical DomainEvent，不进入 `.taskseal/events.jsonl` 或 Workflow replay。
- observation sink 失败不能改变 Provider inspection、preview 或 apply 的真实返回值和错误。
- apply observation 发生在真实 service 返回之后，不进入 canonical batch commit 事务区间。
- API 只有 `GET /api/providers`；demo mode、其他 method 和写 route 均不开放。
- `createLocalCodexRuntime()` 与独立 `taskseal run` 不打开 observation store。
- 当前 store 只保证单实例串行写，不把 atomic rename 当作多进程事务锁。

## 验证证据

- `npm run typecheck`：通过。
- observation、storage、coordinator、facade、runtime 与 server 定向测试：通过。
- `npm test`：323/323 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过。
- 生产依赖保持为 0。
- 路径与凭证扫描未发现开发者机器绝对路径或 Token；唯一 URL 命中为测试中的本地监听地址。
- 独立后端与安全复审：无剩余 P0–P3。

## 剩余风险

- rename 前失败若已创建 temporary slot，会保留一个有界 orphan；恢复前需要操作者先确认 `.taskseal` 仍是工作区内真实目录，再移除该 slot。
- 多进程并发 writer 仍没有事务锁；当前通过 whole-file reload 和 atomic replace 支持读取其他进程已提交状态，但写入应优先集中到 Control Room。
- 本切片没有 operation journal、UI 可视化、动态插件隔离或新的外部写权限；分别由后续 Issue `#29`、`#24` 与 `#34` 处理。

## 结论

Issue `#23` 已建立安全、持久、可复核的 Provider Observation 后端闭环，并保持 read model、canonical journal 与外部 Provider 写权限三者分离；`#24` 可以直接消费固定五态与安全摘要完成 Control Room 可视化。
