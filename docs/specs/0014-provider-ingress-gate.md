# 规格 0014：Provider ingress gate 与 per-scope import 授权

## 目标

在开放 Gitee 或未来第三方 Provider 的本地 snapshot import 前，证明所有新的 rich/provider-managed canonical facts 都只能经过可复核的受控入口：

```text
ProviderSnapshot
  → trusted ProviderIngressRegistry
  → exact ImportPolicy v2 scope
  → deterministic ImportPlan v1
  → current registry + current scope policy recheck
  → atomic ImportBatch v1 + ImportReceipt
```

本规格对应 GitHub Issue `#34`。它不增加外部 Provider mutation、CLI/HTTP apply route、动态代码加载、插件市场、生产凭证或默认授权。

## 所有权与边界

- `ProviderIngressRegistry` 由 application/composition root 拥有，显式注册允许参与本地 snapshot import 的 provider、scope kind 与 object type。
- `AdapterManifest v1` 继续只声明 read capability；发现一个 read adapter 不会自动注册 import ingress。
- `ImportPolicy v2` 拥有精确 provider/scope 的 preview/apply 授权，不注册 Provider，也不定义 Provider identity/URL 规则。
- snapshot importer 拥有 GitHub、Linear、Gitee 的 source identity、scope、URL、candidate 与 content digest 对账。
- Domain 只拥有通用 rich link 结构、对象唯一性、字段管理权、revision 与交付不变量。
- Storage 只拥有有界持久化和原子 batch，不读取 registry 或 policy。
- Replay 只校验已持久化的 versioned event/batch，不读取今天的 registry 或 policy。

## ProviderIngressRegistry v1

可信注册是仓库内显式组合的静态合同：

```text
schemaVersion: 1
provider: stable identifier
capability: snapshot.import
scopes:
  - kind: stable identifier
    objectTypes: non-empty unique identifiers
validator: trusted provider-specific fact validator
```

首个 built-in registry 明确注册：

- GitHub：repository / issue、pull_request、check；
- Linear：team / issue；
- Gitee：repository / issue。

注册、scope 和 object type 必须 exact-key、bounded、无重复；每个 registration 还必须显式提供可信 validator，对 rich link、artifact 与 evidence 的 identity、scope 和 URL 做 Provider-specific 对账。未知 provider、被移除的 registration、错误 scope kind、不支持的 object type 或 validator 拒绝均失败关闭；registry 自身异常不得泄露 cause。

当前 registration 使用状态型撤销：未提交 plan 在 registry 被移除时失效；若以后恢复完全相同的 registration 且 Workflow/policy 未变，旧 plan 可再次满足 gate。需要“一次撤销永久废止旧 plan”时，必须另行升级持久化 binding 并引入 grant revision，不能隐式改变 v1 digest。

## ImportPolicy v2

Live preview/apply 只接受：

```json
{
  "schemaVersion": 2,
  "allowedScopes": [
    {
      "provider": "gitee",
      "scopeRef": {
        "kind": "repository",
        "key": "gitee:repository:owner/repository"
      },
      "objectTypes": ["issue"],
      "capabilities": {
        "snapshot.import.preview": true,
        "snapshot.import.apply": false
      }
    }
  ]
}
```

规则：

- preview/apply 两个布尔字段必须在每条 scope 显式出现；
- `apply: true` 要求 `preview: true`，`false/true` 非法；
- `false/false` 表示保留坐标但撤销该 scope；
- scope identity 是完整的 provider、kind、key、parentKey；
- objectTypes 与 scopes 规范排序并拒绝重复；
- v1 顶层全局 apply policy 不再用于新 preview/apply。

Preview 选择唯一 scope 后生成版本化 binding：

- GitHub、Linear 继续生成并读取 `PolicyBinding v1`，历史 digest 不变；
- Gitee 只使用 `PolicyBinding v2`，明确标记新增 Provider 的 reader 边界；
- `previewAllowed` 只控制能否生成计划，不持久化；所选 scope 的 `applyAllowed` 进入 binding。

`ImportPlan v1`、`ImportBatch v1` 和 receipt shape 保持不变，但其内嵌 `PolicyBinding` 是 v1/v2 联合。旧版本二进制不得读取含 Gitee binding v2 的新 batch；发布顺序必须先部署能读取 v2、但 Gitee apply 仍关闭的 reader，再启用 Gitee writer。回滚到不识别 binding v2 的二进制不支持读取已经提交的 Gitee batch。

## 新写入与 replay

### Snapshot preview

顺序固定为：

1. 有界解析并执行 Provider-specific snapshot/candidate 校验；
2. registry 绑定 provider、scope kind 与 required object types；
3. ImportPolicy v2 解析精确 scope；
4. 要求该 scope 的 preview 为 true；
5. 生成既有 deterministic plan/binding/digests。

### Snapshot apply

已提交 plan 的 receipt lookup 仍先返回 idempotent 结果。未提交 plan 在 write queue 内按以下顺序处理：

1. 校验 plan、plan digest 与 event/action identity；create/link rich link、observation/baseline、title update source 的 providerObjectKey 和 source revision 必须与所属 action 身份一致；
2. 重验当前 registry；
3. 执行不调用 Domain simulation 的入口预检：确认每个 action sourceObjectKey、无事件 skip 的既有事实、create/link 的直接 rich link、refresh/update 依赖的当前或同计划 link、artifact 与 evidence 都通过该 registry validator，并与唯一 PolicyBinding 的 provider/scope/objectTypes 一致；legacy baseline 会由当前 legacy link + baseline + observation 预构造出待形成的 rich link 进行同等校验；
4. 重读可信 ImportPolicy v2 并重建所选 binding，要求当前 apply 为 true 并比较 policyDigest；
5. 检查 conflicts 与 base Workflow digest，使通过入口预检但合法过期的计划稳定返回 `IMPORT_PLAN_STALE`；
6. 只执行一次按序 Domain simulation，并再次校验投影后的 rich link、legacy baseline 与 observation/update 结果；
7. 原子提交 batch 和 receipt。

未知/撤销 registry、scope 删除、apply 关闭、stale policy、stale Workflow、cross-provider/cross-scope plan 与领域冲突都必须在 storage 前失败。Registry 撤销以及可直接判定的 plan 事实越界在 policy 前失败；Domain simulation 只位于 live policy/base-stale 判定之后，避免把通过入口预检的过期计划误报为 tampered。

### Direct append

通用 `TaskSealService.append` 不携带 plan、actor、scope policy 或审批摘要，因此不得成为 provider ingress：

- rich `work_item.created`；
- `external_link.linked`；
- `external_link.observed`，包括 legacy baseline；
- provider-sourced `work_item.updated`；

全部返回固定 `PROVIDER_INGRESS_FORBIDDEN`。本地 legacy WorkItem、Attempt、Artifact、Evidence 和 Acceptance 事件保持可用。已在 journal 中出现的相同 event ID 继续遵守既有幂等语义。

### Replay

`TaskSealService.open` 不注入当前 registry/policy：

- 旧 bare GitHub/Linear rich events 继续 replay；
- arbitrary legacy reference 继续作为非托管 link replay；
- legacy baseline 始终只允许历史 GitHub/Linear issue；
- 历史 ImportBatch/PolicyBinding v1/receipt 继续校验与恢复；新进程同时读取 Gitee PolicyBinding v2；
- Provider 撤销不会把历史事实解释为 journal corrupt。

直接操作 storage adapter 仍处于既有同进程可信边界；storage 不复制 application/domain 门禁。

## Provider-neutral Domain 与 Gitee import

rich link 的通用结构不变量是：

- `providerObjectKey` 是非空稳定 opaque identity；Domain 不重新推导历史 key；
- `scopeRef.key` 以 `provider:scopeKind:` 开头；
- parent scope（如有）属于同一 provider；
- URL、managedFields 与 observation 满足既有通用校验。

Provider-specific 规则留在 import/registry：

- Gitee 只支持 repository scope 与 issue；
- repository coordinate 大小写规范为小写，part 只允许既有 Gitee bounded slug；
- externalId 为 `owner/repository#CaseSensitiveIssueReference`；
- providerObjectKey 为 `gitee:issue:<externalId>`；
- live ingress 要求 providerObjectKey 与 provider/objectType/externalId 一致；历史 opaque rich key 仍可 replay；
- URL 路径逐段固定为 `https://gitee.com/<owner>/<repository>/issues/<CaseSensitiveIssueReference>`；repository path 与 Gitee coordinate 一样大小写不敏感，Issue reference 保持 exact case；禁止空段、尾随斜杠、credential、port、query 和 fragment；
- candidate rich link 必须逐字段匹配 source、scope、mapping、revision 与 content digest。

Gitee read manifest 本身不授予 import。只有 built-in registry registration 与调用方提供的精确 ImportPolicy v2 scope 同时成立，才能 preview/apply；direct append 始终拒绝。

## 来源证明边界

本规格授权的是 Provider + exact repository/team scope，并校验可由离线 plan 自证的结构关系。`providerObjectKey`/scope 是本地对象身份，URL 是需要满足固定 origin/path/scope 规则的 locator：

- Gitee externalId 自带 repository + case-sensitive Issue reference，因此可在本地把 identity 与 URL 精确对账；
- GitHub database ID 与 Issue/PR number、Linear UUID 与 identifier 是远端 API 的不同字段；当前离线 plan 没有可信材料证明二者在远端真实对应；
- `planDigest` 与调用方传入的 `expectedPlanDigest` 用于绑定人工审查内容，不是来源签名；允许 apply 的 application caller 仍属于可信同进程边界。

因此 registry 会拒绝 GitHub 跨 repository、Linear scopeRef 漂移、错误 origin/path 等可判定越界，但不会声称仅凭公开字段证明 GitHub database ID ↔ number 或 Linear UUID ↔ identifier 的远端映射。该能力由 GitHub Issue `#48` 以 versioned connector attestation、只读 re-read 或持久 plan store 方案另行决策；不得通过增加调用方可重算字段制造虚假证明。

## 验收与验证

- unknown/revoked registry 在 policy/journal 前失败；
- per-scope `FF/TF/TT` 能力矩阵成立，`FT` 非法；
- 同 Provider 不同 scope 不串权，无关 scope 改动不改变所选 binding/digest；
- direct rich create/link/observe/update 全部零写入；
- forged cross-provider plan 在 policy/journal 前失败；
- forged same-provider URL、当前 link 跨 scope、artifact/evidence 跨仓库在 policy/journal 前失败；
- action identity 与 create/link/observation/baseline/update payload 的 provider object 或 revision 不一致时，在 policy/journal 前失败，不能让 gate 校验 A 而 Domain 修改 B；
- 无事件 exact-duplicate/stale skip 也必须对当前事实重验 scope，不能把错误 scope 的 no-op receipt 写入 journal；
- 通过入口预检的计划在 Workflow 已变化时先返回 `IMPORT_PLAN_STALE`，不能因提前 simulation 误报 tampered；
- 合法 legacy baseline 后紧跟 managed title update 时只提交一个 batch，并把 legacy link 升级为已授权 rich link；
- 最大合法 Gitee repository/reference identity 可生成并校验 plan；
- 历史 opaque rich providerObjectKey 可 replay，新 live import 仍要求规范 identity；
- GitHub/Linear 同 scope 的 ID↔locator 远端真实性明确属于 #48，不把公开 digest 描述为 attestation；
- Gitee preview-only 与 apply scope 行为明确，Issue reference case drift 失败关闭；
- apply 后即使 registry/policy 撤销，历史 batch/receipt 仍能无当前授权 replay；
- GitHub、Linear、legacy、并发、fencing、atomic batch 和完整测试集无回归。
