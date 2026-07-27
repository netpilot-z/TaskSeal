# ADR 0006：Provider ingress 使用可信 registry 与 per-scope policy

- 状态：Accepted
- 日期：2026-07-28
- 关联：GitHub Issue `#34`

## 背景

TaskSeal 已有 GitHub/Linear snapshot import 和 Gitee read adapter，但存在两个扩展阻塞：

1. 通用 `TaskSealService.append` 可以直接写入合法 GitHub/Linear rich events，绕过 ImportPolicy、plan 与 receipt；
2. ImportPolicy v1 的全局 apply 布尔值会让新增 allowed scope 隐式继承写权限。

如果先把 Domain 放宽为任意 Provider，Gitee 或未来插件只需构造 canonical event 就可能进入 journal。若把当前 registry/policy 注入 Domain，又会让历史 journal 能否 replay 取决于今天启用的 Provider。

## 决策

采用以下组合：

```text
trusted registry
AND exact per-scope ImportPolicy v2
AND deterministic plan binding
AND live apply recheck
```

- 增加 application-owned `ProviderIngressRegistry v1`；read-only AdapterManifest 不自动注册 import。
- ImportPolicy 升级为 v2，把 preview/apply 下沉到每个精确 scope；live v1 global policy 失败关闭。
- GitHub/Linear 保持 `PolicyBinding v1` 与历史 digest；Gitee 使用 `PolicyBinding v2` 明示新增 reader 边界。ImportPlan、ImportBatch 与 receipt 外层仍为 v1。
- 通用 direct append 拒绝所有 rich/provider-managed canonical writes；这些新事实只能由受控 atomic snapshot batch 写入。
- Apply 在 policy 前重验 registry，并验证所有 plan action/event 都与唯一 provider/scope/objectTypes binding 一致；event payload 实际引用的 provider object/source revision 必须与所属 action identity 相同，不能让门禁验证一个 link 而 Domain 修改另一个 link。
- Replay 不查询当前 registry/policy。
- 完成门禁后，Domain rich link 改为 Provider-neutral 结构校验；legacy upcast/baseline 仍只识别既有 GitHub/Linear。
- Gitee 作为首个通过新门禁开放的本地 import Provider；其 source/scope/URL/reference 校验仍是 Provider-specific。

## 选择理由

- 关闭已证实的 direct append 绕过，同时不把授权状态引入纯 Domain 或 storage。
- 新 Provider 至少需要代码注册、Provider-specific importer 和精确 scope policy 三个独立条件，不能靠 allowedScopes 或 manifest 单独获得权限。
- 历史 GitHub/Linear receipt/digest/batch 无 schema 迁移；新 reader 可同时回放 binding v1/v2，禁用 Provider 也不会阻断启动。
- 当前没有可信 direct-rich application 用例，禁止通用 append 比增加隐式授权上下文更小、更安全。

## 被拒绝方案

### 只在 Connector 检查

拒绝。任意 application caller 仍可绕过 Connector 调用 `append`。

### Registry 注入 Domain

拒绝。今天禁用 Provider 会使昨天的合法 journal 无法 replay。

### AdapterManifest 自动授予 import

拒绝。Read capability、import ingress 和外部 mutation 是独立能力；发现 adapter 不能提升权限。

### 把 Gitee 写进 PolicyBinding v1

拒绝。旧 reader 的 v1 provider 枚举只有 GitHub/Linear；把 Gitee 仍标为 v1 会隐藏真实的回滚边界。当前只升级内嵌 PolicyBinding 到 v2，Plan/Batch 外层保持 v1；未来 registration grant revision 属于另一项 schema 变更。

### 受 registry/policy 保护后继续允许通用 direct rich append

拒绝当前采用。Generic append 缺少 plan digest、actor 和原子 receipt；需要该用例时应新增专用 command 与审计合同。

## 后果

- 所有 live ImportPolicy 调用方必须迁移到 v2；旧 PolicyBinding v1/batch 仍永久可读。
- Gitee writer 必须采用 expand-reader-first 发布：先部署支持 binding v2 的 reader 且保持 Gitee apply 关闭，再启用写入。含 Gitee batch 后，回滚到旧 reader 不受支持。
- Provider-specific snapshot normalizer 仍需显式实现，registry 不是动态代码加载器。
- Gitee local import 可用，但没有 CLI/HTTP apply route，也不产生任何外部 Gitee 写入。
- Registry 撤销是状态型；完全恢复相同 registration 可能使仍未 stale 的旧 plan 再次有效。
- 当前 gate 证明 Provider/scope 授权和可离线验证的 locator 结构，不证明 GitHub database ID ↔ Issue/PR number 或 Linear UUID ↔ identifier 的远端真实性。`planDigest` 不是来源签名；对象级 provenance 由 Issue `#48` 另行引入可信 attestation、只读 re-read 或持久 plan store。
- 动态插件、租户隔离、签名包、远程执行和第三方代码 sandbox 仍需新的 ADR。
