# 实验 0001：交付证据闭环

## 实验卡

- 决策：是否继续把 TaskSeal 产品化为独立于 Agent Runtime 和任务平台的 AI 交付控制层。
- 假设：来自 Linear、Codex 和 GitHub 的事件可以通过一个小而稳定的契约归一为 WorkItem、Attempt、Artifact、Evidence 和 AcceptanceDecision，并可重放得到确定的验收状态。
- 反证：平台字段持续泄漏到领域模型；重复事件会产生重复记录；缺少交付物或必需证据时仍能被接受；同一事件序列无法确定性重放。
- 指标：
  - 完整演示序列最终得到一个 `accepted` WorkItem。
  - 重放相同事件不会增加 Attempt、Artifact 或 Evidence 数量。
  - 缺少任一必需证据时，接受操作必须失败。
  - 自动化测试可用一个命令重复运行。
- 边界：不覆盖真实 OAuth、Webhook、外部写入、多租户、权限、计费、生产持久化和任意 Agent 市场。
- 时限：以一个本地、可运行、可测试的纵向切片为停止点，不继续补生产能力。
- 环境：Node.js 24 或兼容版本；无生产依赖；使用匿名本地夹具。

## 设计摘要

- 行为与非目标：验证证据驱动的交付状态流；不验证大规模调度或完整项目管理。
- 模块与职责：领域模块拥有状态和不变量；连接器只负责归一外部事件；演示模块提供固定事件序列；HTTP 层只负责展示和触发。
- 依赖方向：HTTP 和连接器依赖领域契约，领域模块不依赖任何平台或框架。
- 数据与控制流：外部夹具 → Connector → DomainEvent → Workflow replay → Dashboard projection。
- 公共契约：带稳定 `eventId`、`workItemId`、`type`、`occurredAt` 和 `payload` 的 DomainEvent。
- 错误与失败边界：无效状态转换和证据不足以显式领域错误返回；外部鉴权与网络失败留给后续适配器。
- 测试策略：领域单元测试覆盖状态、不变量和幂等性；连接器契约测试覆盖归一结果；本地 HTTP 冒烟测试覆盖演示入口。
- 替代方案与取舍：可以直接把 Linear/GitHub 字段写进单一数据库表，代码更少，但会让验收规则依赖具体平台；当前窄事件契约多一个映射步骤，却保留替换 Gitee、飞书和其他 Agent Runtime 的可能。
- 迁移步骤与回退：原型文件全部独立在仓库内；若假设被反驳，可删除实验实现而不影响外部系统。

## 结果记录

### 原型结论

- 假设：Linear、Codex 和 GitHub 的事实可以归一到一条确定、幂等且有证据门禁的交付链路。
- 结果：在 fixture 范围内支持。
- 证据：
  - `npm test` 覆盖领域状态、连接器契约、完整重放和 HTTP 演示。
  - 完整六步事件序列最终得到一个 `accepted` WorkItem，其中 Attempt 完成由独立终态事件确认。
  - 同一序列重复投递不会增加 Attempt、Artifact 或 Evidence。
  - 缺少 Artifact 或 required Evidence 时，接受决定返回 `ACCEPTANCE_EVIDENCE_INCOMPLETE`。
  - Evidence 必须匹配当前 Attempt 和 Artifact revision。
  - 浏览器检查确认 `planned → running → accepted` 可视状态和控制按钮有效。
- 反驳证据：尚未获得。当前实验没有覆盖真实 API、乱序 Webhook、Token 生命周期和平台限流，因此不能外推真实连接可靠性。
- 适用边界：匿名本地 fixture、单 WorkItem、单 active Attempt、单 required Evidence、人工最终接受。
- 原型代码位置：仓库中的 `src/`、`public/`、`fixtures/` 和 `test/`。
- 复现方式：

  ```bash
  npm test
  npm start
  ```

- 是否建议产品化：建议进入第二个实验，但不建议直接按生产系统建设。
- 产品化前必须补齐：
  - 一个真实 GitHub 只读链路。
  - 一个真实 Linear 只读链路。
  - Webhook 乱序、冲突 revision 和失败重试验证。
  - 凭证、权限和租户隔离设计。
  - 持久化、审计、可观测性和受控写回策略。
