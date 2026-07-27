# ADR 0003：选择 Gitee 作为第二 Provider

- 状态：已接受
- 日期：2026-07-27
- 决策范围：GitHub Issue `#9`、`#10` 与 `#25` 的执行顺序和首版插件边界

## 背景

TaskSeal 已有 GitHub、Linear 的真实只读 inspection、ProviderSnapshot v2 和受策略约束的原子 import。下一步需要第二个 repository/work-item Provider 来判断哪些代码是稳定插件契约，哪些仍应保留为 Provider 本地逻辑。

现有实现仍在多个层次枚举 `github | linear`：

- snapshot 与 import policy 的 Provider/object type/scope 白名单；
- snapshot importer 的对象身份、URL 与 candidate event 校验；
- 领域 RichExternalLink 的 Provider scope 校验；
- inspection、CLI 和配置分支。

如果接入 Gitee 只是把每个枚举增加一个分支，以后每个 Provider 都会修改领域核心，这不符合最终的可扩展目标。但当前 `TaskSealService.append` 允许可信 application caller 直接追加 canonical event，并不经过 AdapterManifest 或 ImportPolicy；现有 import apply 开关也是全局布尔值，而不是 per-provider/per-scope。此时直接把领域改成接受任意 Provider，或把 Gitee 加入 import 白名单，都会扩大未受门禁保护的写入面。相反，一开始建立动态插件市场、远程代码执行和完整 SDK 也缺少真实重复模式。

## 决策

### 1. 第二 Provider 选择 Gitee Issue

GitHub Issue `#10` 实现两个只读能力：

- `provider.health`：精确验证一个公开仓库 scope；
- `work-item.read`：读取一个显式指定的 Gitee Issue 并生成 ProviderSnapshot v2。

首版只支持匿名公开资源，不实现 query token、OAuth、私有仓库、Issue list、PR、CI、Webhook 或任何写入。

Gitee 配置只包含非敏感 repository coordinate。公开 smoke 使用 `oschina/git-osc` 与 Issue `I4`；自动化测试使用 fake transport。

Gitee inspection 输出裁剪后的 ProviderSnapshot v2 读模型，但 GitHub Issue `#10` 不把 Gitee 加入 ImportProvider、ImportPolicy allowed scope 或领域 ExternalLink allowlist。Gitee `ProviderIssueFact.candidateEvent` 必须携带 rich ExternalLink，不能仿照历史 Connector 生成任意 Provider 都可重放的 legacy reference；把 snapshot 自带 candidateEvent 直接传给 `TaskSealService.append` 必须由当前 rich Provider allowlist 拒绝。调用 snapshot import preview/apply 同样失败关闭。Gitee 本地 import 由 GitHub Issue `#34` 跟踪，需要先完成 per-scope apply 与统一 journal ingress gate。

### 2. 首个切片保留领域 Provider allowlist

GitHub Issue `#10` 不做 Provider-agnostic 领域重构。领域继续只接受明确列入当前 rich ExternalLink allowlist 的 Provider，直接 append snapshot 自带的 Gitee rich candidateEvent 必须失败。既有任意 Provider 的 legacy reference 仍可作为非托管链接重放，但 Gitee adapter 不生成新的 legacy candidate；legacy link 不能 baseline、管理字段或获得 import 能力。

Gitee read adapter 仍必须在 inspection 边界验证 Provider 特有规则：

- Gitee/GitHub repository slug；
- Gitee host、URL path和区分大小写的 Issue number；
- Gitee 只允许 repository scope 与 issue object type；
- SourceRevision、content digest 和显式 WorkItem mapping。

真正的 Provider-agnostic RichExternalLink 由 GitHub Issue `#34` 跟踪，必须同时满足两个前置条件：

1. 所有 external-link journal ingress（包括 direct append）都经过可信 Adapter registry gate；
2. ImportPolicy 将 apply 授权改为 per-provider/per-scope，不能由全局开关让新增 scope 自动可写。

满足前置条件后，领域才收敛为通用结构/业务不变量，Provider scope/URL/ID 留在 Adapter、registry 和 ImportPolicy。历史 legacy upcast 始终只识别既有 GitHub/Linear 日志。

### 3. 只提取内置、版本化的最小插件契约

首版 `ProviderAdapter` 是仓库内受信任模块，不动态加载第三方代码。`AdapterManifest v1` 只表达：

- schema/API version；
- 稳定 provider ID；
- capabilities；
- configuration schema；
- credential reference mode；
- scope kinds 与 object types；
- health/read ports。

能力采用显式 allowlist。声明 `work-item.read` 不会获得 `work-item.transition`、snapshot apply、comment、close 或 acceptance write。

Gitee 的 `AdapterManifest` 首版 credential mode 为 `none`，capabilities 只有 `provider.health` 与 `work-item.read`。它没有 preview/apply/write port；现有 snapshot importer 必须拒绝 Gitee。可读 snapshot 不因 schemaVersion 为 2 自动获得本地 journal 写权限。

### 4. 飞书作为第三个异构压力测试

GitHub Issue `#25` 依赖 Gitee `AdapterManifest`/ports 稳定后再开始。飞书需要验证：

- tenant/user token 与资源授权；
- app/table/record scope；
- POST 形式的只读查询；
- HTTP 200 + 非零业务 code；
- 动态字段映射与敏感字段裁剪。

如果飞书不能适配 `AdapterManifest v1`，则通过新版本扩展契约；不能把 Provider 本地动态字段塞进领域事件。

## 备选方案

### 先接飞书

优点是能更早暴露异构数据模型。缺点是当前没有专用应用、凭证、资源授权或固定字段样本；认证、动态 schema 和业务错误会同时引入过多变量，无法快速判断失败来自插件边界还是环境配置。

不采用为第二 Provider，保留为第三个压力测试。

### 只在所有枚举中追加 `gitee`

实现最直接，但领域层会继续承担 Provider scope grammar，每个新平台都要修改核心。它能“接通 API”，却不能验证用户需要的可扩展 Agent/Provider 接入边界。

不作为最终架构。首个只读切片甚至不修改领域/import allowlist；等统一 ingress gate 建立后再删除领域 Provider 枚举。

### 先设计完整通用 SDK/市场

可以预留动态安装、签名、沙箱、版本解析和计费，但当前只有内置 Provider，无法用真实重复模式证明这些抽象。

不采用；先提取可信内置 `AdapterManifest`/ports。

### 直接复用 GitHub adapter

Gitee 与 GitHub 都有仓库 Issue，但编号类型、API host、响应 schema、认证和错误模型不同。共享整个 adapter 会隐藏 Provider 差异并扩大错误匹配。

不采用；只共享已经由第二实现证明稳定的 transport/result/capability 结构。

## 审查驱动修订

独立架构审查关闭了三个初始设计风险：

1. 初始方案准备让 Gitee 进入 import preview，但现有 apply capability 是全局布尔值；一旦 Gitee scope 被允许，已有全局 apply 会隐式让它可写。修订后 #10 完全不进入 ImportProvider/ImportPolicy，per-scope 授权拆到 `#34`。
2. 初始方案准备立即把领域改成 Provider-agnostic，但 direct append 不经过 AdapterManifest/ImportPolicy，会让未知 rich link 绕过门禁。修订后领域 allowlist 保持不变，Gitee snapshot 自带 rich candidate 并用 direct append 失败测试封住漏口。
3. 初始身份使用响应整数 `id`，但官方 schema 没有声明其全局唯一且不可变。修订后使用 repository-scoped、区分大小写的 Issue number，并把 rename/move 定义为显式 mapping drift。

最终复审未发现剩余 P0–P3。

## 影响

- 最快获得第二个 Provider 的公开真实证据，不需要凭证或外部写授权。
- GitHub Issue `#10` 不修改领域 ExternalLink 或 ImportPolicy 的 Provider allowlist，现有 GitHub/Linear rich link、legacy replay 与 apply 面保持不变。
- Gitee snapshot 可用于 inspection、展示和 Adapter contract 验证，但 import preview/apply 明确拒绝。
- Provider-agnostic domain、registry ingress gate 与 per-scope apply 由 GitHub Issue `#34` 形成独立后续安全切片，不能混入最小 Gitee read。
- 首版插件不是 npm 包或 Codex 动态插件，不触发 monorepo、远程代码执行或市场安全模型。
- 飞书的 POST-read、业务 error envelope 与动态字段会对 `AdapterManifest v1` 形成真正的异构反证。

## 验收门禁

GitHub Issue `#10` 只有在以下证据同时成立时才能关闭：

1. 现有 GitHub/Linear、legacy journal 和 snapshot import 全量回归通过；
2. Gitee fake contract 覆盖 health、Issue read、scope drift、number case、URL、错误脱敏、primitive/null/array JSON 和响应上限；
3. 只读 manifest 无写 port，且无法通过 capability 名称或 HTTP method 获得写权限；
4. 公开 Gitee smoke 返回一个裁剪 ProviderSnapshot v2，journal 与外部对象均未变化；
5. Gitee snapshot 进入 preview/apply 时失败关闭；将该 snapshot 自带的 rich candidateEvent 直接 append 也必须失败；
6. 独立架构、安全和 diff 审查无剩余 P0–P3。

## 参考

- [调研 0002：Gitee 与飞书第二 Provider 契约探针](../research/0002-gitee-feishu-provider-probe.md)
- [连接器边界](../architecture/connectors.md)
- [Snapshot Import ADR](0001-snapshot-import-contract.md)
- [Provider inspection 与 Linear dry-run 规格](../specs/0003-provider-inspection-and-linear-dry-run.md)
- [Snapshot Import 规格](../specs/0004-snapshot-import.md)
