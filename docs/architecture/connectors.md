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
- ProviderSnapshot v2 的 preview、受策略约束的原子 apply 与可恢复 receipt。
- 静态 AdapterManifest v1、capability/port runtime contract，以及 Gitee 匿名 repository health 与单 Issue read。
- 独立 Provider Observation v1、五态 latest-state projection 与 persistent-only `GET /api/providers`。

当前没有 Provider Webhook 或任何外部写入。

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
| `provider.health` | 验证配置、凭证与精确 scope 是否可读 | GitHub、Linear、Gitee、飞书 |
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

## 已实现阶段：Snapshot import

Snapshot import 契约已由 `docs/specs/0004-snapshot-import.md` 与 `docs/adr/0001-snapshot-import-contract.md` 决定并实现：

- 用 `ProviderObjectKey` 和 `external_link.linked` 支持一个 WorkItem 关联 Linear 与 GitHub Issue。
- 用显式 `managedFields` 决定 canonical 字段归属，禁止按 provider 类型或导入顺序覆盖。
- 用 `SourceRevision`、`external_link.observed` 和严格限定的 `work_item.updated` 表达 provider 编辑。
- 先生成零写入 ImportPlan，再把 canonical events 与 ImportReceipt 作为一个 journal batch 原子提交。

Atomic apply 已通过故障注入、并发、未知提交结果 fencing 和重启恢复验证；apply capability 默认关闭，只有可信 ImportPolicy 明确允许的 scope 才可写入本地 journal。

## 已实现阶段：Gitee 只读 Adapter

ADR 0003 选择的 Gitee Issue 只读切片已经完成：

1. `AdapterManifest v1` 精确声明 `provider.health` 与 `work-item.read`，并与同名 ports 一一对应；
2. Gitee 只使用固定 origin、匿名 GET、有界响应和精确 repository/Issue/URL 对账；
3. Gitee Issue 使用 repository-scoped、区分大小写的 identity，snapshot 自带 rich candidateEvent；
4. read-model 可表达 `provider = gitee`，import 层仍只有 GitHub/Linear；Gitee preview、伪造 apply 与 candidate direct append 均零写入失败关闭；
5. 公共 `oschina/git-osc#I4` health/read smoke 成功，前后 journal 哈希相同。

## Provider Observation 读侧

Provider inspection、snapshot preview 和 snapshot import 的结果通过 application coordinator 投影为脱敏最新状态：

```text
configured target + operation start
  → provider/preview/import result
  → safe observation summary
  → .taskseal/provider-observations.json
  → GET /api/providers
```

该文件与 `.taskseal/events.jsonl` 严格分离：

- observation 不是 canonical DomainEvent，不参与 Workflow replay；
- identity 使用 provider + configured target，observed scope 只作为结果字段；
- repository target/scope 精确对账；Linear inspection 用同一配置快照把 workspace/team 引用绑定到 connector 已验证的 UUID scope；
- freshness 使用 operation start time，较早请求晚完成时被忽略；
- 只保存 revision/digest、missing evidence 与 allowlist diagnostic code；
- raw payload、标题、URL、凭证、错误正文、stack/cause 和 import actor 不进入文件或 API；
- observation sink 故障不能替换 Provider read、preview 或 import 的原结果；
- preview/apply 的 production application caller 使用 `ObservedSnapshotImportFacade`，并携带 configured target → resolved scope binding；跨 Provider/foreign scope 在 service 前失败关闭；纯 preview 与 `TaskSealService` 保持原有边界，且不新增 HTTP/CLI 写入口。

v1 只保证单一 read-model 实例内串行写入；多个进程并发 whole-file replace 不属于当前能力。Query 每次重载有界 JSON，使运行中的 Control Room 能看到后续 CLI 已完成的原子替换。多 writer 或远程平台出现后，应把写入集中到服务端或重新决策事务型存储。

## 下一阶段：统一 ingress gate 与异构 Provider

- GitHub Issue `#34` 建立统一 ingress registry gate、per-provider/per-scope apply 与后续 Provider-agnostic domain。
- 用飞书多维表格的 token、动态字段和业务 error envelope 对 AdapterManifest v1 做异构压力测试。
- Gitee 或其他 Provider 的 import/write 只有在独立能力、策略、审计和明确授权同时成立后才能开放。

只有成功样本与插件边界验证后才考虑：

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

当前没有建立通用 `BaseAdapter`、事件总线或插件市场。第二 Provider 只提取受信任的版本化 `AdapterManifest` 和窄 ports；动态代码加载、签名、沙箱、分发和计费仍需独立需求与安全设计。
