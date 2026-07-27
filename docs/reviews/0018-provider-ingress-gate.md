# 审查 0018：Provider ingress gate 与 per-scope import 授权

## 状态

通过。对应 GitHub Issue `#34`；实现与攻击复审发现的 action/fact 对账、失败顺序、no-event owner、composition 和 legacy baseline 问题均已修复，最终独立复审未发现剩余 P0–P3。

## 独立审查范围

1. ProviderIngressRegistry 的显式注册、provider/scope/object type 与 fact validator 边界；
2. ImportPolicy v2 的 per-scope preview/apply、PolicyBinding v1/v2 兼容和 stale 语义；
3. direct append、ImportPlan action/event/payload identity、两阶段 apply gate 与 atomic batch；
4. Gitee identity、URL、大小写、最大合法长度和 Provider-neutral Domain；
5. legacy/opaque rich link replay、baseline + title update、receipt/restart 与 runtime composition；
6. GitHub/Linear 对象级 provenance 的可证明边界。

## 初审问题与修复

### Direct rich event 可绕过受控 import

Generic `append` 原本可接受 provider-backed rich create/link/observe/update，绕过 policy、plan、actor 与 receipt。现统一返回 `PROVIDER_INGRESS_FORBIDDEN`，但 exact duplicate 与历史 replay 保持既有语义；本地 legacy、Attempt、Artifact、Evidence 和 Acceptance 事件不受影响。

### 全局 apply 会被新 scope 隐式继承

ImportPolicy v1 的全局 apply 布尔值无法表达 scope 隔离。Live policy 已升级为 v2，每个精确 scope 分别声明 preview/apply，`FT` 非法；GitHub/Linear 持久 PolicyBinding 保持 v1 digest，Gitee 通过显式 v2 暴露 reader 迁移边界。

### Plan binding 未逐项约束事实

仅验证 registry target 不能阻止调用方替换 plan binding 后重算公开 digest。现 action source type、create/link rich link、当前/投影 link、artifact/evidence 和 no-event skip 都与唯一 provider/scope/object types binding 对账；Gitee URL 与 repository/reference 规则由 Provider-specific validator 负责。

### Apply 校验顺序误报 stale plan

把全部事实校验放在 policy/base 前会提前运行 Domain simulation，使合法但过期的计划误报 tampered；全部后移又会让明显伪造计划先读取 policy。现采用两阶段顺序：policy 前执行不调用 Domain 的 action/direct/current/no-event fact 预检，current policy/conflicts/base 通过后只运行一次 Domain projection 并验证投影 link。

### No-event skip 可转绑错误 WorkItem

初始实现按整个 Workflow 全局查找 source key，重算 action/plan digest 后可把 receipt 中的 action 指向错误 WorkItem。现只在 `workflow.workItems[action.workItemId]` 内查找 link/artifact/evidence；错误 WorkItem 固定 `IMPORT_PLAN_TAMPERED`、零提交。

### Action identity 与 event payload 实际对象可分离

`external_link.observed` 和 `work_item.updated` 的 gate 曾按 action key 验证对象 A，但 Domain 按 payload key 修改对象 B；同一 WorkItem 下两个 repository link 时可形成跨 scope 更新。ImportPlan reader 现把 create/link/observation/baseline/update payload 的 providerObjectKey 与 source revision 强绑定到所属 action。双 link 错配、baseline、refresh 和 title-update mutation 均在 policy 前拒绝。

### Legacy baseline 后的合法 title update 被预检误拒

Baseline observation 会在同一 batch 中先把 legacy link 升级为 rich link，随后 title update 才能取得管理权。预检现从当前 legacy link、baseline 与 observation 预构造待形成的 rich link 交给 registry 校验，并记录为同计划 link；不运行 Domain simulation，合法 baseline + update 可原子提交。

### Runtime composition 未转发同一 registry

Observed preview 与 service apply 必须共享同一显式 registry。CLI runtime composition 现完整转发注入值；custom revoked registry 回归证明不会退回默认实例。

## 复审结论

- Unknown/revoked Provider、未授权 scope、preview-only apply、stale policy/base 和所有已知 fact mismatch 均在 journal 前零写入。
- Cross-provider、same-provider foreign URL、当前 link 跨 scope、双 link payload/action 错配、artifact/evidence 跨仓库和 no-event wrong owner 均失败关闭。
- Replay 不读取当前 registry/policy；历史 opaque rich key、PolicyBinding v1、batch 与 receipt 保持可读，Gitee 使用 PolicyBinding v2。
- Gitee repository coordinate 大小写规范化，Issue reference 保持 exact case；最长合法 identity 仍可 preview/apply。
- Domain 只保留 Provider-neutral 结构与业务不变量；registry 不是 read manifest、动态插件加载器或外部写权限。
- GitHub database ID ↔ number、Linear UUID ↔ identifier 的远端真实性不能由当前离线 plan 自证，已拆为 `#48` / `T11.5`，公开 digest 不被描述为 attestation。

## 验证证据

- Registry/ImportPolicy 定向测试：11/11 通过。
- Gitee/direct gate/Provider-neutral Domain：23/23 通过。
- ImportPlan/apply/snapshot 定向测试：40/40 通过。
- `npm run typecheck`：通过。
- `npm test`：505/505 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过，仅有工作区 CRLF 转换提示。
- 生产依赖：0。
- 改动文件本地绝对路径与常见密钥模式扫描：无命中。
- 本切片没有 UI 变更，因此未执行浏览器走查。

## 剩余风险

- 当前 registry 是仓库内 trusted built-in registration，不是可安装第三方代码的签名、沙箱或多租户授权系统。
- Registry/policy 撤销是状态型；完全恢复相同授权且 plan 未 stale 时，旧 plan 可能重新有效。
- Gitee 首次写入前必须先发布能读取 PolicyBinding v2 的版本；写入 v2 batch 后不能回滚到旧 reader。
- 当前只有 application API 的本地 journal apply；没有 CLI/HTTP apply、Provider 外部写回、真实 Linear mutation 或自动 Linear ticket 同步。
- 对象级 connector provenance、可信 attestation/只读 re-read/persistent plan store 由 `#48` 决策。

## 结论

#34 已建立“trusted registry AND exact per-scope policy AND deterministic plan binding AND live apply recheck”的最小闭环，并安全开放 Gitee 本地 import。下一步不扩张本票；先由 #48 解决对象级 provenance，再决定第三方插件与远程执行边界。
