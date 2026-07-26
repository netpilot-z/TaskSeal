# 实验 0002：Codex App Server Runner

## 实验卡

- 决策：Codex App Server 是否能作为 TaskSeal 第一个真实 Runner，并在不写外部任务平台的前提下形成可观察、可恢复的 Attempt 闭环。
- 假设：本地 WorkItem 可以先持久化 Attempt start，再运行一个 App Server thread/turn，最后把 completed、failed 或 interrupted 归一为稳定领域事件。
- 反证：协议字段泄漏到领域模型；进程完成但 journal 无终态；Agent completed 被误判为 accepted；只读冒烟修改项目文件；Control Room 无法观察运行中状态。
- 边界：单项目、单进程、一个 WorkItem 同时一个活跃 Attempt；无 Linear/GitHub 写入，无 Artifact 自动提取，无多 Runner 调度。

## 实际结果

- JSONL journal 支持 append、fsync、损坏检测、幂等提交和重启重放。
- Codex App Server fake 覆盖 completed、failed、interrupted、approval decline、invalid JSON、early exit 和 timeout。
- 首次真实冒烟发现 PATH 中的旧 Codex 无法使用当前默认模型；TaskSeal 随后改为选择本机可用的较新 Codex App binary。
- 真实 read-only turn 返回 `completed` 和固定摘要；从 Attempt 开始到结束没有项目文件发生修改。
- Control Room 从同一个 service projection 读取状态，并通过受控 HTTP 命令异步启动 Attempt。
- 独立审查发现并验证修复了跨站写入口、并发双启动、遗留 running、非法协议 envelope、等待器泄漏和前端快照竞态。
- 写入口现限定 loopback/same-origin/JSON/CSRF，默认 read-only；同 WorkItem 通过 service 原子预留。
- 浏览器实际观察到 Active agents `0 → 1 → 0`、WorkItem `reviewing → running → reviewing`，同时 Acceptance 始终 pending。
- 390px 移动宽度无横向溢出，浏览器控制台无 error 或 warn。

## 得到的结论

假设在当前实验边界内成立。Codex App Server 适合 TaskSeal 需要的 thread、turn、终态、审批拒绝和可视运行态；实验协议被集中隔离在 transport 后，领域和 journal 不依赖其原始字段。

这不代表生产就绪。下一阶段优先验证真实 GitHub/Linear 只读事实和 dry-run 映射，再单独决定是否授权 Linear 写入。

## 已知风险

- App Server 仍是实验接口，需要锁定已验证版本或持续运行 schema 契约测试。
- 当前复用本机 Codex 登录与配置；更严格隔离需要专用 Codex home，避免继承个人已配置工具。
- HTTP 运行入口没有取消按钮、审批 UI、并发队列、重试策略或跨进程恢复。
- completed Attempt 尚不会自动生成 Artifact 或 Evidence，因此只能进入 reviewing。
