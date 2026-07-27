# 实验 0009：Snapshot Import TypeScript 迁移

## 实验卡

- 决策：能否在不改变 ProviderSnapshot v2、digest、排序、冲突、资源限制和原子 apply 语义的前提下，把 Snapshot Import 边界迁移到 strict TypeScript。
- 假设：外部 snapshot 始终保持 `unknown`，先完成树结构与 schema 校验，再形成未授权规范化模型；scope 经过 policy binding 后才成为可用于摘要和计划的授权类型。
- 反证：必须使用 `any`、类型断言或类型忽略；合法 snapshot 的 plan/digest 改变；畸形对象绕过限制；preview、apply 或 crash recovery 行为回归。
- 指标：类型检查、直接与间接闭包测试、全量测试和旧实现差分全部通过；独立审查无剩余 P0–P3。
- 边界：迁移 importer、snapshot fixture 和 preview/domain/apply 直接测试；仅更新 fixture 的必要调用者，不包含 Provider 网络、Runner、CLI、Server 或外部写入。

## Red

机械改名后 `npm run typecheck` 产生 318 条诊断。诊断集中在五类接缝：

1. `JSON.parse`、对象树和 caught error 的 `unknown` 边界；
2. issue、pull request、check fact 与 candidate event 的关联联合；
3. mapping 可选字段、provider index 和 planner 中间结果；
4. fixture 的临时声明与真实实现不一致；
5. 测试中的 nullable lookup、journal 假体和非法输入篡改。

迁移没有通过降低 `tsconfig`、增加声明覆盖或放宽生产类型消除红灯。

## Green

- `parseProviderSnapshotJson(raw: unknown): unknown` 保留不可信输入类型；JSON 文本仍受 1 MiB 限制。
- Tree guard 继续拒绝超深、超宽、稀疏数组、symbol key、accessor、cycle、自定义 prototype、非有限数字和超长字符串。
- 规范化分为 `UnboundNormalizedSnapshot` 与 `AuthorizedSnapshot`：raw scope 不进入 digest 或 plan，只有 `buildPolicyBinding` 返回的 provider-specific 规范化 scope 才能继续。
- issue、pull request、check 分支分别在同一判别分支内构建 source、observation 与 candidate，避免互不相关的联合被拼接。
- Candidate payload 在 exact-key 校验后按事件类型显式复制，不保留 provider raw DTO 或未知字段。
- Planner 复用 `ImportPlan`、`ImportAction`、`ImportPlanEvent` 和领域事件的既有所有权；provider index 与 domain simulation 使用判别联合和安全错误码读取。
- fixture 迁移为真实 TypeScript tuple，删除临时 `.d.ts`；非法 snapshot 测试继续以 `unknown` 构造，不迫使无效数据满足生产 DTO。

## 兼容性证据

- `snapshotDigest` 仍只包含 schemaVersion、provider、授权 scope、mapping 和已排序 facts，不包含 `mode`、`capturedAt`。
- `contentDigest`、`mappingDigest`、`baseWorkflowDigest`、plan/action/event ID 继续调用原有权威实现。
- 字符串集合继续使用默认 `.sort()`；fact、event、action、conflict 和 warning 的确定性排序未改变。
- issue 仍先于 PR/check 规划；projected workflow 与最终 domain simulation 的两阶段流程未改变。
- exact duplicate、event ID conflict、scope/mapping/authority conflict、legacy baseline、stale warning 和 domain rejection 替换语义均由原 golden 测试覆盖。
- 资源限制保持为：1 MiB、深度 16、facts 100、数组 100、对象字段 64，以及原有 title、URL、ID、evidence 和 managed field 上限。

## 审查

独立架构与代码审查没有发现 P0–P3。审查特别核对了两处可能的行为差异：

1. Tree guard 从批量 descriptor 读取改为逐 key descriptor 读取，对 JSON、普通对象和 null-prototype 对象保持相同拒绝规则；带状态 Proxy 在旧实现后续读取中同样不具备稳定快照，没有新增授权或摘要绕过。
2. 未授权模型暂时保留 raw scope，但 policy binding 会立即生成新的规范化 scope；后续 URL 绑定、摘要、plan 和 external link 均不持有 raw scope。

独立 verification pass 发现规格文档仍引用旧 `.js` 文件名，本实验随提交修正为 `.ts`。

## 验证证据

- `npm run typecheck`：通过，318 条诊断收敛为 0。
- Snapshot preview/domain/apply：51/51 通过。
- Import batch、journal import 与 crash recovery 闭包：16/16 通过。
- 扩展定向闭包：71/71 通过。
- `npm test`：229/229 通过，0 skipped。
- HEAD 旧实现与新实现差分：28 个 issue/parse/limit/tamper/update 场景和 7 个 PR/check/sort/identity 场景均为 0 mismatch。
- `git diff --check`：通过；仅有 Windows working-copy 的 LF/CRLF 提示。
- 未发现 `any`、类型断言、类型忽略、旧目标 `.js` import、测试跳过、本地绝对路径或凭证。

## 结论

支持假设。Snapshot Import 已进入 strict TypeScript，同时保持不可信输入运行时校验、授权后 scope、确定性摘要与排序、冲突语义和原子 apply/replay 行为，可以作为 Runner 与 CLI/Server 迁移的前置基线。
