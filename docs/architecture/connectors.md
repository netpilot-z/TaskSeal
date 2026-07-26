# 连接器边界

## 当前结论

TaskSeal 不替代 GitHub、Gitee、Linear、飞书或 Agent Runtime。连接器只把外部事实归一为稳定事件，领域模块负责关联、不变量和验收。

```text
External provider
  → provider-specific validation
  → canonical DomainEvent
  → TaskSeal workflow
  → dashboard / approval gate
```

当前已实现：

- Linear、Codex 和 GitHub 的纯 normalizer。
- GitHub Issue/PR/Check Run 的真实 REST 只读客户端。
- GitHub 单 Issue 的独立只读 snapshot，用于在 PR/Check 尚未就绪时先验证 WorkItem 映射。
- Linear Organization/Team/Issue 的真实 GraphQL 只读客户端。
- 显式映射后的裁剪 snapshot 与内存重放。
- 仓库 tickets 到 Linear Issue 草案的离线 dry-run。

当前没有 snapshot import、Webhook 或任何外部写入。

## 稳定事件契约

```json
{
  "eventId": "provider:record:revision",
  "workItemId": "TS-1",
  "type": "evidence.recorded",
  "occurredAt": "ISO-8601 timestamp",
  "payload": {}
}
```

必须满足：

- `eventId` 对同一来源记录和 revision 保持稳定，用于幂等。
- `workItemId`、`attemptId`、`artifactId` 使用显式关联，不通过标题或时间猜测。
- Evidence 必须携带 Artifact revision；GitHub 场景中对应 PR head SHA。
- 连接器不得直接把 WorkItem 标记为 accepted。
- 外部字段错误、关联缺失或 revision 不匹配必须显式失败。

## 建议能力模型

后续插件声明能力而不是假设所有平台都支持相同操作：

| 能力 | 用途 | 示例提供方 |
| --- | --- | --- |
| `work-item.read` | 读取任务和验收条件 | Linear、GitHub Issues、Gitee Issues、飞书多维表格 |
| `work-item.transition` | 更新任务状态 | Linear、GitHub Issues、Gitee Issues |
| `attempt.observe` | 读取 Agent 执行状态 | Codex、其他 Agent Runtime |
| `artifact.read` | 获取交付物及 revision | GitHub、Gitee、文档或媒体平台 |
| `evidence.read` | 获取 CI、测试、截图或审查证据 | GitHub Actions、Gitee CI、测试平台 |
| `acceptance.write` | 将最终验收结果回写来源系统 | Linear、GitHub、飞书 |

读取与写入能力必须分开授权。插件即使能读取任务，也不能自动获得关闭 Issue 或合并 PR 的权限。

## 已实现阶段：真实只读连接

当前只读链按以下顺序实现：

1. GitHub 只读：读取一个 Issue、关联 PR、head SHA 和 Check Run。
2. Linear 只读：读取 `netpilot-z` workspace、`netpilot` team、`TaskSeal` project 下的一个 Issue。
3. 调用者显式传入 WorkItem/Attempt/criterion 映射，禁止模糊匹配。
4. 用 mocked-real 数据生成 canonical snapshot，并在内存中与 Codex Attempt 重放。

这个阶段只需要匿名公开读取、只读 Token 或 OAuth。不得把 Token 写入项目文件、snapshot 或日志。

Linear 真实环境已用 `NP-1` 完成成功 snapshot，并确认 journal 未变化。GitHub 已用 Issue `#1`、Draft PR `#2` 和 PR head 上成功完成的 `tests` Check 完成完整 snapshot；三事件与显式 Attempt 在内存重放后进入 `reviewing`，Evidence passed，journal 未变化。

## 下一阶段：成功样本、导入与受控写回

接下来先完成：

- 决定是否新增 `external_link.linked`，解决一个 WorkItem 同时关联 Linear 与 GitHub Issue。
- 设计 snapshot import 的冲突、update 语义和审计记录。

只有成功样本与 import 语义验证后才考虑：

- 将验收结果回写 Linear。
- 自动评论或关闭 GitHub/Gitee Issue。
- 创建或更新飞书记录。
- 触发新的 Agent Attempt。

每个写操作都需要：

- 明确的租户、仓库、Team 和目标对象范围。
- 独立权限开关。
- 人工审批策略。
- 幂等键和重复请求保护。
- 操作审计记录。
- 失败后的可恢复状态。

## 主要取舍

当前没有建立通用 `BaseAdapter`、事件总线或插件市场。原因是首个实验只需要证明证据闭环；等第二个真实提供方（例如 Gitee 或飞书）接入后，再根据重复代码提取公共插件接口，证据会比预设抽象更可靠。
