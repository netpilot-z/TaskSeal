# 实验 0021：Provider ingress gate 与 per-scope 授权

- 日期：2026-07-28
- 关联：GitHub Issue `#34`
- 规格：[0014-provider-ingress-gate.md](../specs/0014-provider-ingress-gate.md)
- ADR：[0006-provider-ingress-authorization.md](../adr/0006-provider-ingress-authorization.md)

## 假设

TaskSeal 可以在不改变既有 GitHub/Linear PolicyBinding v1 digest，以及不升级 ImportPlan、ImportBatch 和 receipt 外层 schema 的前提下，同时证明：

1. 新 Provider 不能通过构造 rich canonical event 绕过受控 import；
2. 新 scope 不会继承全局 apply 权限；
3. registry/policy 撤销只阻止新写入，不破坏历史 replay；
4. 门禁建立后，Domain 可收敛为 Provider-neutral 结构校验，并安全开放 Gitee 本地 import。

## Red

第一轮新增 registry 与 ImportPolicy v2 合同测试：

```text
node --test test/provider-ingress-registry.test.ts test/import-policy.test.ts
```

结果为预期失败：registry 模块不存在，六个 per-scope/v2/Gitee policy 行为不满足。

第二轮新增 Gitee、direct append 与 Provider-neutral Domain 测试：

```text
node --test \
  test/gitee-ingress-boundary.test.ts \
  test/provider-neutral-domain.test.ts \
  test/provider-ingress-gate.test.ts
```

结果为 9 个预期失败：Gitee 被旧 ImportProvider allowlist 拒绝、direct rich append 仍可写入、Domain 仍拒绝 Gitee。

最后增加 cross-provider forged plan，用合法 Gitee binding 替换 GitHub plan binding 并重算公开 digest；旧实现会提交该计划，证明 registry target 检查本身不足以绑定 plan 内每个 action/event。

## Green

实现：

- application-owned、strict、显式 built-in 的 ProviderIngressRegistry v1；
- ImportPolicy v2 per-scope preview/apply；GitHub/Linear 保留 PolicyBinding v1，Gitee 使用显式 v2；
- preview 先 registry、后 policy；apply 在 write queue 内重验 registry/current policy；
- apply 先执行不调用 Domain simulation 的 action/direct/current/no-event fact 预检，再重读 policy 和校验 base，最后只做一次 Domain projection 与投影 link 对账；
- plan action/event、当前与投影 link、artifact/evidence 与唯一 provider/scope/objectTypes binding 的逐项对账；
- generic direct rich/provider-managed append 固定拒绝；
- replay 不读取当前 registry/policy；
- Gitee repository/Issue identity、URL、candidate 与 case-sensitive reference import 校验；
- Provider-neutral rich link Domain，历史 opaque key 可 replay，live validator 仍要求规范 identity；legacy baseline 继续只认 GitHub/Linear。

定向结果：

```text
node --test test/provider-ingress-registry.test.ts test/import-policy.test.ts
11 passed

node --test \
  test/gitee-ingress-boundary.test.ts \
  test/provider-neutral-domain.test.ts \
  test/provider-ingress-gate.test.ts
23 passed

npm run typecheck
passed
```

完整回归：

```text
npm test
505 passed, 0 failed
```

## 观察

- 每个 scope 的 `FF/TF/TT` 能力可以独立表达；`FT` 在 policy parser 阶段失败。
- 无关 scope 不进入目标 PolicyBinding，因此不会制造无关 stale；目标 apply 或 scope 变化仍会在 commit 前失败。
- Gitee read manifest 没有变化，也没有新增 write port；本地 import capability 来自独立 trusted registry 与 policy 的交集。
- Direct rich create/link/observe/update 均为零 journal write；本地 legacy/Attempt 路径保持可用。
- forged cross-provider、same-provider 越界 URL、当前 link 跨 scope、artifact/evidence 跨仓库均在 policy 前失败；通过预检但 base 已变化的合法计划仍返回 `IMPORT_PLAN_STALE`，没有被提前 Domain simulation 误报为 tampered。
- ImportPlan parser 将 create/link/observation/baseline/title-update payload 的 providerObjectKey 与 source revision 绑定到所属 action；即使同一 WorkItem 同时存在获批与未获批 scope 的 link，也不能让 gate 校验 A 而 Domain 更新 B。
- Legacy baseline 在预检阶段由当前 legacy link、baseline 与 observation 预构造 rich link 并交给 registry 验证，不运行 Domain simulation；合法 baseline + managed title update 仍可原子提交。
- 无事件 skip 会在目标 WorkItem 内重验既有 fact；重算公开 action/plan digest 也不能把正确 source 绑定到伪造 WorkItem 后写入 receipt。
- 已提交 Gitee batch 在 registry 被移除、没有 policy provider 时仍能 reopen 并恢复 receipt。
- 既有 GitHub/Linear v1 binding/batch/receipt 测试无需迁移即可继续通过；Gitee binding v2 明确暴露 expand-reader-first 与旧二进制回滚边界。

## 结论

支持实验假设。TaskSeal 已证明“read adapter、import ingress、scope authorization、external write”是四个独立能力。下一 Provider 仍需显式 registration、Provider-specific normalizer 与精确 policy，不能仅靠 manifest 或 allowedScopes 获权。

当前撤销是状态型：完全恢复相同 registry/policy 且 Workflow 未变化时，旧 plan 可能重新有效。需要永久 grant revocation 时再升级持久化 binding；本实验不提前支付该迁移成本。Gitee 首次写入前必须先发布支持 PolicyBinding v2 的 reader，写入后不支持回滚到旧 reader。

当前离线 gate 证明 Provider、精确 scope 与可离线验证的 locator 结构，不证明 GitHub database ID ↔ number 或 Linear UUID ↔ identifier 的远端真实性。该 provenance 能力已拆为 GitHub Issue `#48` / `T11.5`，需要可信 connector attestation、apply-time 只读 re-read 或持久可信 plan store；公开 digest 不能替代来源证明。
