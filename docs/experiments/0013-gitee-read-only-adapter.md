# 实验 0013：Gitee 只读 Adapter 与插件契约

## 实验卡

- 决策：能否在不放宽领域/import allowlist、不新增生产依赖和不使用凭证的前提下，接入第二个 repository Provider，并提取可复用的只读 AdapterManifest/ports。
- 假设：Gitee 匿名 repository health 与单 Issue read 可以归一为 ProviderSnapshot v2；read-model 与 import authorization 分离后，snapshot 可展示但不能进入任何本地写入入口。
- 反证：需要 Token 或写权限；Provider capability 会隐式获得 append/apply；Gitee snapshot 能进入 preview/apply/direct append；repository/Issue/URL 漂移不能可靠识别；公共样本需要修改 journal。
- 指标：fake contract、三重 ingress 拒绝、CLI/inspection、公共 smoke、全量测试、独立架构/安全/diff 审查。
- 边界：匿名公开仓库、一个显式 Issue、静态进程内 Adapter；不含私有资源、列表、PR/CI、Webhook、动态插件、import 或外部写入。

## Red

初始代码只有 GitHub/Linear 的读取与 import 路径，没有：

1. 版本化 manifest 与 capability/port 对账；
2. Gitee 配置、固定 origin transport、正文上限和 runtime payload guard；
3. repository-scoped、区分大小写的 Gitee Issue identity；
4. Gitee inspection/CLI；
5. read-model 与 `ImportProvider` 的显式边界。

新增测试先分别因缺少 contract、配置 getter、Gitee client/normalizer、inspection/CLI 和稳定拒绝码失败。

## Green

- `AdapterManifest v1` 声明 API version、provider ID、capabilities、配置 schema、credential mode、scope 和 object type。
- runtime contract 使用 exact-key、dense array、无重复和 capability/port 一一对应校验；未知 capability、额外 append/apply/write port、HTTP method 声明或 credential reference 均拒绝。
- Gitee client 固定使用 `https://gitee.com/api/v5` 匿名 GET、`redirect: error`、15 秒默认 timeout 和 256 KiB 响应上限。
- JSON 在上限检查后解析；primitive、null、array、非法 JSON、HTTP 分类、scope drift、number case drift 与 URL drift 均返回稳定且不回显正文的错误。
- Issue identity 为 `gitee:issue:<repository>#<case-sensitive-number>`；API 整数 ID 和 state 不进入 snapshot。
- candidateEvent 携带完整 rich ExternalLink，不生成 legacy Gitee link。
- `inspect gitee-health` 输出裁剪 health；`inspect gitee` 强制 schema v2、显式 mapping 和 title management。
- snapshot importer 在读取 ImportPolicy 前以 `SNAPSHOT_PROVIDER_NOT_IMPORTABLE` 拒绝 Gitee；伪造 apply 以 `IMPORT_PLAN_TAMPERED` 拒绝；direct append 以 `EVENT_PAYLOAD_INVALID` 拒绝。

## 真实只读 smoke

2026-07-27 使用公共 repository `oschina/git-osc` 与 Issue `I4` 运行两个 adapter ports：

- health：HTTP 200，scope 为 `gitee:repository:oschina/git-osc`；
- work-item.read：HTTP 200，返回一个 ProviderSnapshot v2；
- source identity：`gitee:issue:oschina/git-osc#I4`；
- revision：`2022-07-22T05:01:31+08:00`；
- candidate link：rich；
- 请求数：两个匿名 GET；
- 外部写入：0；
- raw response 保存：0。

运行前后 `.taskseal/events.jsonl` SHA-256 均为 `1BBFBEA5618644DB2297F784EC97B1CC2B76002DE74ADF8804FD13EDA25CCA57`。

公共样本不写入 `config/project.json`，因为它不是 TaskSeal 项目的 Gitee repository 坐标。

## 验证证据

- Gitee/adapter/ingress/inspection 定向测试：通过。
- `npm run typecheck`：通过。
- `npm test`：282/282 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过。
- 生产依赖保持为 0。

## 结论

支持实验假设。TaskSeal 已证明“新增 Provider 可被发现和读取”不等于“新增 Provider 可写入”。AdapterManifest/ports 足以承载首个同构扩展；统一 journal ingress gate 与 per-scope apply 仍由 GitHub Issue `#34` 负责，飞书将用来反证该 v1 契约能否适配异构认证、scope 与动态字段。
