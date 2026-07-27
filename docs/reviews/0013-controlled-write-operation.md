# 审查 0013：受控 Linear 写 Operation 合同

## 状态

通过。对应 GitHub Issue `#39`；审查对象包括 Operation Plan、摘要 identity、审批绑定、状态机、runtime parser、相邻 snapshot replay、Linear correlation 证据和安全持久字段。

## 独立审查范围

独立只读后端审查覆盖：

1. client UUID、operation key、payload/plan digest 与 scope drift 分类；
2. approval TOCTOU、状态/version/时间不变量与 terminal fence；
3. not-dispatched、outcome unknown、absent、failed 和 ambiguous 对账语义；
4. Linear Issue ID 与 resolved Team correlation；
5. exact-key 对象读取、Unicode/control 字符、长度和脱敏边界；
6. 相邻 snapshot 的 plan、actor、createdAt、submission/reconciliation 与 diagnostic 不变性。

## Finding 与闭环

### 成功结果缺少 resolved Team 验证

初始成功 action 只携带 `{id, identifier}`。即使 Issue ID 等于 client UUID，错误 transport 仍可把另一 Team 的 Issue 宣告为 `created` 或 `reconciled`。

现要求 `submission_created` 与 `reconciliation_found` 同时携带 `observedTeamId`。状态机先校验 Issue ID 与 client UUID、observed Team 与 resolved Team，再只持久化脱敏 Issue identity；提交与对账路径各有 mismatch 回归。

### 单 snapshot parser 不能证明 replay 合法

初始 parser 能分别接受合法 v2 approved 和合法 v3 submitting，但无法发现 v3 将既有 approval actor 替换为另一人。让 storage 自行比较字段会复制并漂移整套状态规则。

现新增唯一 pair validator：分别规范化 previous/next，要求 version `+1`，从 next 推导唯一 action，调用原状态机重建 expected record，最后做 canonical exact equality。测试覆盖所有合法边，以及 actor、plan、createdAt、既有 submission 字段篡改、跳号与回退。

### 摘要与 correlation 合同不完整

审查发现早期规格漏写 operation key preimage 的 `schemaVersion`，且 client UUID 如何进入 Provider 未被证明。现已让规格与实现一致并增加固定 digest golden vector；官方 Linear schema 证据支持把 UUID v4 写入 `IssueCreateInput.id`，对账固定使用 `issue(id: clientRequestId)`。

该证据不构成重复 create 的原生幂等承诺，因此 unknown fence、journal 和真实写前专用 probe 保持为硬门禁。

### Runtime 对抗性输入

实现过程中发现 lone surrogate、enumerable `__proto__`、C1 control 与 Unicode 行分隔符边界。现通过 descriptor-safe exact record、null-prototype copy、well-formed string 和明确 control allowlist 失败关闭，并保留回归测试。

## 架构边界

- 状态模型是纯 application contract，不读取文件、不调用网络、不持有凭证。
- Operation Journal 独立于 canonical workflow journal 与 Provider Observation。
- success receipt 只保存 UUID/identifier；Team 只作为 transition 时的 scope proof，不扩大持久展示面。
- outcome unknown 后不存在 create retry 状态；absent 只允许再次 query。
- #40 必须从 v1 开始逐对调用 pair validator，不能只验证最后一条或跳过中间 version。
- #41 必须返回可判别的 `not_dispatched` / `outcome_unknown`，不能解析异常正文猜测。

## 验证证据

- 受控写定向测试：12/12 通过。
- `npm run typecheck`：通过。
- `npm test`：344/344 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过。
- 独立后端最终复审：无剩余 P0–P3。

## 剩余风险

- Operation Journal、崩溃恢复和 CAS 尚未实现。
- fake Linear transport 与 coordinator 尚未证明先持久 submitting、一次 transport permit 和 unknown recovery。
- 官方资料没有承诺相同 UUID 的重复 create 幂等；任何真实 mutation 都仍需专用 probe 与新的明确授权。
- 当前只设计单进程 writer；多进程/远程控制面不在本切片范围。

## 结论

#39 已把受控 Linear 写的 identity、scope、审批、状态和 replay 规则集中到一个可执行合同，且没有开放任何外部写入口。可以进入 #40 的独立持久化切片。
