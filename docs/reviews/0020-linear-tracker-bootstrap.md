# 审查 0020：Linear Tracker Bootstrap

- 关联：Linear `NP-1`
- 范围：配置、dry-run、Project/State resolver、GraphQL HTTP exchange、工作跟踪规范和 bootstrap manifest
- 日期：2026-07-28

## 初审发现

### P2：默认 dry-run 指向历史已完成里程碑

已修复：

- 默认 source 改为专用 `0006-linear-bootstrap-manifest.md`；
- manifest 排除已有 `NP-1` 映射的 T15.1；
- 任意显式 source 中的已完成状态也不会生成草案；
- 自动化测试证明历史 `0002` 的 issue count 为零。

### P2：只读 T16 被可写凭证不必要阻塞

已修复：

- T16 实现依赖收窄为 T15.1 的只读 resolver；
- T15.3 只门禁真实 bootstrap、迁移和 submit，不阻塞 ready-work read 合同的实现与测试。

### P2：连续空 chunk 可绕过 streaming timeout

已修复：

- fetch 前建立 monotonic total deadline；
- 每次 `reader.read()` 前后检查 deadline；
- zero-length chunk 固定拒绝；
- empty chunk 和 microtask-heavy native `ReadableStream` 回归均通过。

### P3：README 固定声明草案数量

已修复：

- 删除固定数量，改为描述“当前 manifest 中未完成、未映射的条目”；
- manifest 建立远端映射后可以缩减，而不让 README 再次过期。

## 架构与兼容结论

- application-owned v1 write port、ControlledWriteOperation、Operation Journal 和 Coordinator 均未修改。
- resolver 与 HTTP detail 保留在 connector 层，没有形成反向依赖或写入口。
- Project/State/source intent 没有旁路进入 v1；后续必须使用 v1/v2 union reader 和 v2 digest。
- 顶层本地项目名与 Linear Project 已分离。
- Linear 内部任务、GitHub 外部问题和 GitHub 代码交付的职责边界已经明确。

## 安全结论

- API key 与 OAuth token 二选一，credential、底层异常和 raw GraphQL error 不进入公共错误。
- fetch 前非法输入才是 `not_dispatched`；调用 fetch 后的 throw、abort、body failure、超限或 timeout 都是 `response_lost`。
- request/response、节点、页数、游标、文本和 UUID 都有边界。
- adversarial option/response traps 被归一为固定安全结果。
- 本切片不实例化真实 mutation transport，不创建后台任务，也不保存 resolved UUID。

## 门禁

- TypeScript 和 627 项全量测试通过。
- `git diff --check` 通过。
- 真实只读 resolver smoke 通过。
- 独立后端与架构复审未发现剩余 P0–P3。
