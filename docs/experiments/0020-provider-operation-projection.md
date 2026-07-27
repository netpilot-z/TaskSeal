# 实验 0020：Provider Operation 安全投影

## 实验卡

- 决策：能否在不开放任何写入口的前提下，把 Provider Observation 与 Operation Journal 的 latest 状态组合到 Control Room，并保持两个来源的独立所有权和新鲜度。
- 假设：application-owned 组合 query 只消费两个窄 query port，服务端返回白名单 v2 projection，浏览器按 source-local identity/version 防回退，即可安全展示审批、提交、未知结果与对账状态。
- 反证：operation 字段泄露 payload、actor、client UUID、resolved UUID、Issue identity 或错误正文；任一 source 失败仍返回 partial 200；v2 回退到 v1、较旧 Observation 或较低 Operation version 覆盖 last-known；浏览器产生 approve/submit/reconcile 请求；移动端溢出。
- 指标：投影/runtime/HTTP/浏览器状态定向测试、全量测试、类型检查、浏览器桌面与移动走查、生产依赖、diff 检查及独立后端/前端/架构审查。
- 边界：latest projection 不是完整审计历史或跨文件原子快照；没有 coordinator、transport、credential、真实 Linear mutation、浏览器 command route 或多租户远程访问。

## Red

按 TDD 先建立三组失败：

1. application 测试因 `provider-sync-projection.ts` 不存在而以 `ERR_MODULE_NOT_FOUND` 失败；
2. HTTP/runtime 测试因 server 仍只接受 Observation v1 query 而类型失败；
3. 浏览器状态测试因 v2 summary、operation-only 内容和 source-local anti-regression 尚未实现而失败。

这些失败固定了安全字段、十态映射、双来源整次失败、query-only startup、v1/v2 兼容和 last-known 防回退合同。

## Green

- `ProviderSyncProjectionQuery` 并行读取 `observations.list()` 与 `operations.listLatest()`；不读取 storage envelope，不依赖 coordinator 或 transport。
- Operation latest 最多 512 条，再次通过完整状态 parser、拒绝重复 key，并按 provider/target/operation key 规范排序。
- `failed` 只在公开 projection 中映射为 `sync_failed`；其余九种状态保持领域语义。
- approval 仅保留 decision 与 decidedAt；payload、client UUID、resolved UUID、plan digest、actor、Issue identity、raw body、cause 和路径均不进入 projection。
- Observation 与 Operation 分别保留 component revision；combined revision 只绑定两个内容指纹，不作为全局可排序版本。
- `GET /api/providers` 返回 exact v2/no-store；任一 source 失败固定脱敏 503，不返回 partial 200。
- persistent startup 只打开 file-backed Operation Journal query；不会 coordinator recovery、transport 或外部请求。
- 浏览器兼容 v1，并在接受 v2 后拒绝 v2→v1；Observation 按 `provider + target key / startedAt`、Operation 按 `operationKey / version` 防回退。
- Control Room 展示所有十种状态、operation-only 内容、需审批/不确定/失败汇总和唯一 aria-live 摘要；没有新增写按钮或写请求。
- 浏览器走查发现移动端单列 grid 会被长内部文本撑宽；为 panel 增加 `min-width: 0` 后，390px 视口不再横向溢出。

## 验证证据

- Projection/runtime/HTTP/前端状态定向测试：27/27 通过。
- `npm run typecheck`：通过。
- `npm test`：472/472 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过。
- 生产依赖：0。
- 浏览器桌面/390px 移动走查：Provider 卡片、operation 空态、Refresh 与 aria-live 摘要可用；无横向溢出、无 console warning/error。
- 独立后端、前端与架构审查：见 `docs/reviews/0017-provider-operation-projection.md`。

## 结论

实验支持假设。TaskSeal 已能把两个独立本地事实源组合成可复核、可防回退的只读 Provider status v2，并在 Control Room 中展示受控写 latest 状态。该结果验证的是安全可观察性，不代表已开放真实 Linear 写入、远程团队访问或跨文件事务。
