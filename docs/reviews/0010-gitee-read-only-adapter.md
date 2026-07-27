# 审查 0010：Gitee 只读 Adapter 与插件契约

## 状态

通过。对应 GitHub Issue `#10`；审查对象包括 AdapterManifest/ports、Gitee 匿名读取 client、ProviderSnapshot v2 归一化、inspection/CLI、import ingress 边界、配置与相关文档。

## 独立审查范围

进行了两个独立只读 pass：

1. 架构与边界 pass：read-model/import authorization 分离、manifest/port 对账、repository scope、identity、现有 GitHub/Linear 路径兼容性和 Issue `#34` 的后续边界。
2. 安全与 verification pass：固定 origin、匿名请求、redirect/timeout、响应上限、runtime payload guard、错误信息、response stream cleanup、三重 ingress 拒绝、凭证/路径/依赖扫描和全量测试。

## Finding 与闭环

### P2：非成功响应没有释放正文流

安全 pass 发现非 2xx 响应直接分类错误，没有发起 response body cancellation。高频错误响应可能占用连接与缓冲资源。

首次修复新增零正文读取、一次取消的回归测试，并在错误分类前执行 best-effort cancellation。

### P2 复审：等待悬挂 cancellation 会阻塞错误返回

首次修复会等待 cancellation Promise；当自定义 transport 或响应流的 `cancel()` 永不 settle 时，HTTP 错误也永不返回。

最终修复先用红灯测试稳定复现 `still-pending`，再把 cleanup 改为同步发起且不等待：

- 同步异常和异步 rejection 均被隔离；
- cleanup 不会替换稳定的 provider 错误；
- 永不 settle 的 cancellation 仍立即返回 `GITEE_NOT_FOUND`。

复审确认原 P2 已关闭，未发现其他 P0–P3。

## 架构边界

- `ProviderName` 可包含 `gitee` 只表示 read-model 可识别该来源；`ImportProvider` 仍只允许 GitHub/Linear。
- Gitee snapshot 只用于 inspection/display，不获得 preview、apply 或 journal append 权限。
- 三个入口分别以 `SNAPSHOT_PROVIDER_NOT_IMPORTABLE`、`IMPORT_PLAN_TAMPERED` 和 `EVENT_PAYLOAD_INVALID` fail closed，且拒绝发生在 policy、journal 或 commit 副作用之前。
- 本切片不引入动态插件加载、私有资源、Token、列表、PR/CI、Webhook、外部写入或 provider-agnostic import。
- 统一 ingress gate 与 per-scope apply 保留给 Issue `#34`。

## 验证证据

- `npm run typecheck`：通过。
- Gitee 定向测试：通过，包含 manifest、transport、normalizer、inspection/CLI 与三重 ingress 边界。
- `npm test`：282/282 通过，0 fail、0 skipped、0 todo。
- 公共只读 smoke：`oschina/git-osc#I4` health/read 成功，共两个匿名 GET，未保存 raw response。
- smoke 前后 `.taskseal/events.jsonl` SHA-256 均为 `1BBFBEA5618644DB2297F784EC97B1CC2B76002DE74ADF8804FD13EDA25CCA57`。
- `git diff --check`：通过。
- 生产依赖保持为 0；未引入凭证或开发者机器绝对路径。

## 剩余风险

- 公共匿名 API 的可用性与限流由 Gitee 控制；当前只提供稳定错误分类，不提供重试或缓存。
- v1 manifest 是静态进程内契约，尚未证明动态发现、第三方代码隔离、签名、权限授予或版本协商。
- Gitee snapshot 暂不能导入或驱动本地交付状态；开放该能力前必须完成 Issue `#34` 的统一入口门禁。

## 结论

Issue `#10` 已验证第二个 repository Provider 可以通过最小、只读、无凭证的 AdapterManifest/ports 接入，同时保持“可发现和读取”与“可写入”严格分离；该契约可作为后续飞书等异构 Provider 实验的基线。
