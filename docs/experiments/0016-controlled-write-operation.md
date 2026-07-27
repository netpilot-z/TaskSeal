# 实验 0016：受控 Linear 写 Operation 合同

## 实验卡

- 决策：能否在零真实 mutation、零 transport 和零持久化的前提下，先证明一次 Linear Issue 创建可以被不可变 plan、人工审批、严格状态机与未知结果对账合同安全描述。
- 假设：持久 client UUID、domain-separated digests、resolved scope、版本化完整 snapshot 和唯一相邻转换验证器，足以为后续 Operation Journal 与 fake transport 提供单一运行时合同。
- 反证：同一 UUID 的 scope/payload 漂移被当作新 operation；审批后 plan 可替换；错误 Team 或错误 Issue 被记为成功；unknown 后可再次 create；两个各自合法的 snapshot 能篡改既有审批或审计字段；任意错误正文进入 record。
- 指标：状态机定向测试、固定 digest golden vector、非法对象/字符/时间/转换反例、全量测试、类型检查、diff 检查与独立后端审查。
- 边界：本切片不创建 `.taskseal` operation 文件，不调用 Linear，不提供 CLI/HTTP mutation，也不消费真实凭证。

## Red

最初没有受控写状态模型，新增测试因模块缺失失败。实现后的对抗性测试又依次暴露：

1. lone surrogate 进入 canonical digest 时产生了错误层级的异常；
2. enumerable `__proto__` 可绕过普通对象键检查；
3. C1 control 与 Unicode 行分隔符可进入持久字符串；
4. 成功 action 只有 Issue identity，无法验证 Provider 实际返回的 Team；
5. 两个 snapshot 各自合法且 version 连续时，仍可在相邻版本中替换 approval actor、plan、createdAt 或既有 submission 审计字段。

这些反例均先稳定失败，再修改生产代码。

## Green

- Operation Plan v1 固定 `linear / work-item.write / work-item.create`，绑定 configured target、resolved Organization/Team UUID、UUID v4、payload 与三个 domain-separated digest。
- operation key 只绑定 client UUID 与固定 action；同 UUID 的 scope/payload 漂移因此分类为 conflict，新 UUID 才是 different operation。
- approval 绑定 exact operation key 与 plan digest，只接受脱敏的稳定 human actor ID。
- 状态机显式区分 `not_dispatched` 与 `outcome_unknown`；unknown、reconciling 和 absent 均禁止再次 create，只能显式查询。
- create/found action 必须携带 Provider 实际观测的 Team UUID；状态机同时验证 Issue ID 等于 client UUID、observed Team 等于 resolved Team，record 只保存 `{id, identifier}`。
- `validateControlledWriteOperationTransition` 从 next snapshot 推导唯一 action，复用同一状态机重建 expected snapshot，再做 canonical exact equality；Journal 后续不需要复制状态规则。
- exact-key validator 使用 descriptor-safe、null-prototype 读取，拒绝 accessor、symbol、额外字段、污染 prototype、非 canonical UUID/timestamp、危险控制字符和越界文本。
- 所有返回对象深度冻结；record 不包含 Token、headers、raw body、URL、stack 或错误正文。

## Correlation 证据

Linear 官方 schema 明确允许调用方为 `IssueCreateInput.id` 提供 UUID v4；官方开发文档允许按 Issue UUID 查询。因此 fake 合同固定为：

```text
create.id     = plan.clientRequestId
create.teamId = plan.resolvedTarget.teamId
query.id      = plan.clientRequestId
```

官方资料没有承诺重复 create 原生幂等，所以 Operation Journal 和 unknown fence 仍不可省略；真实 mutation 前还需重新核验当前 schema 并获得新的明确授权。

## 验证证据

- 受控写状态模型定向测试：12/12 通过。
- `npm run typecheck`：通过。
- `npm test`：344/344 通过，0 fail、0 skipped、0 todo。
- 一次高负载全量运行曾出现两个既有 Codex App Server deadline 超时；对应文件单独复跑 19/19，随后同一工作树全量复跑 344/344。
- `git diff --check`：通过。
- 独立后端最终复审：无剩余 P0–P3。

## 结论

支持实验假设。TaskSeal 已获得一个纯离线、可重放且失败关闭的受控写 Operation v1 合同；下一步应由 `#40` 从 v1 开始逐对调用相邻转换验证器，建立 bounded、atomic、expected-version Operation Journal。该结果不代表真实 Linear 写入已启用。
