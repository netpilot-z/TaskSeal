# 调研 0002：Gitee 与飞书第二 Provider 契约探针

> 后续状态：先接 Gitee 的顺序决策已验证；飞书随后由 Linear `NP-11` 完成真实只读压力测试，最终边界见 [ADR 0017](../adr/0017-feishu-opaque-read-scope.md)。

## 调研范围

本调研只回答 GitHub Issue `#9` 的可证伪问题：TaskSeal 应先用 Gitee Issue，还是飞书多维表格记录，作为第二个只读 Provider 来反证插件边界。

核验日期为 2026-07-27。探针只读取官方文档和公开资源，不使用凭证，不保存原始响应，不修改任何外部对象。

## 结论

选择 Gitee Issue 作为第二 Provider；飞书多维表格保留为 Gitee 契约形成后的异构压力测试。

原因不是 Gitee 功能更多，而是它能以最低权限和最少前置条件回答当前最重要的问题：

1. 公开仓库和 Issue 可以匿名读取，立即获得真实网络证据；
2. `owner/repo/number` 与现有 repository-scoped WorkItem 模型接近，能先暴露哪些边界是真正可复用的；
3. Gitee Issue 编号是区分大小写的字符串，并非 GitHub 的正整数，可有效反证“所有 Issue 编号都是数字”的错误抽象；
4. 飞书必须先准备应用、access token、文档权限、app/table/record 和动态字段映射，同时存在 HTTP 成功但业务 `code` 非零的错误模型，更适合在最小插件契约形成后做第二轮压力测试。

## 官方契约

### Gitee Open API

[Gitee Open API Swagger](https://gitee.com/api/v5/swagger) 当前加载的官方 schema 为 [Gitee Open API JSON](https://gitee.com/api/v5/doc_json)，探针观察到版本 `5.4.92`。

最小路径：

```text
GET /api/v5/repos/{owner}/{repo}
GET /api/v5/repos/{owner}/{repo}/issues/{number}
```

仓库和单 Issue 接口都要求 `owner` 与 `repo`；Issue 额外要求 `number`。官方 schema 把 `number` 定义为区分大小写的 `string`，且明确无需 `#`。`access_token` 是可选 query 参数。

首个切片不发送 `access_token`。把凭证放入 query 可能进入代理、访问日志或诊断输出；在私有仓库读取成为真实需求前，应另行核验安全认证传输与最小 scope，不能为了预留功能先实现有泄漏风险的路径。

Issue schema 没有把响应字段声明为 required，因此客户端仍必须把 JSON 视为 `unknown`，并显式要求当前切片使用的字段：

- 正整数 `id`，用于响应 shape 与重复读取核对；官方 schema 没有声明它跨仓库全局唯一且不可变，因此首版不单独用它构造对象身份；
- 区分大小写的字符串 `number`，用于操作者输入与返回值核对；
- `title`、`html_url`、`created_at`、`updated_at`；
- `repository.full_name`，用于防止 scope drift；
- `state`，只作为 Provider 本地事实，不直接改变 TaskSeal 验收状态。

列表接口使用 `page`/`per_page`，其中 `per_page` 最大 100；单 Issue 与仓库 health probe 不需要分页，因此首个实现不引入列表遍历。

官方 schema 也暴露 Pull Request、Issue 关联 PR 与 commit Check Runs，说明 Gitee 后续可扩展到 Artifact/Evidence 链。但公开探针发现文档与真实 JSON 存在漂移：PR `head` 的文档类型与真实对象不同，Check Runs 的文档引用与真实 `{total_count, check_runs}` envelope 不同。因此首个切片只做 Issue；未来交付链必须继续使用 `unknown` + runtime guard，不能依赖 Swagger codegen 的静态形状。

### 飞书多维表格

[飞书访问凭证](https://open.feishu.cn/document/ukTMukTMukTM/uMTNz4yM1MjLzUzM) 区分 `tenant_access_token` 与 `user_access_token`：前者以应用身份访问应用被授权的数据，后者以用户身份访问该用户可访问的数据。

[多维表格概述](https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/bitable-overview) 把资源分成 app、table、view、record 与 field；单条记录至少由 `app_token`、`table_id` 和 `record_id` 定位。

[查询记录](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table-record/search) 使用带 Bearer token 的 `POST .../records/search`，单页最多 500 行并使用 `page_token`。它虽然是只读能力，却使用 POST，因此插件权限不能只按 HTTP method 推断。

响应使用 `code`、`msg`、`data` envelope；官方错误表包含 HTTP 200 搭配非零业务 code 的情况。实现必须同时检查 HTTP 状态与业务 code，不能把 200 等同成功。

记录的 `fields` 是用户定义的动态对象；人员、附件、关联、公式等字段还涉及额外权限或不同数据形态。首版必须使用显式字段映射，只提取标题和必要时间字段，不能把整个 `fields` 放入 snapshot。

## 能力矩阵

| 维度 | Gitee Issue | 飞书多维表格记录 | 对当前决策的影响 |
| --- | --- | --- | --- |
| 最小认证 | 公开资源可匿名读 | 必须提供 tenant/user access token | Gitee 可立即做零凭证真实探针 |
| 精确 scope | owner/repo/number | app_token/table_id/record_id，加字段映射 | Gitee 更适合先验证 repository scope |
| WorkItem 语义 | 固定 Issue schema | 用户自定义字段组成记录语义 | 飞书更能压力测试，但前置更多 |
| 单对象读取 | GET 单 Issue | GET 单 record 或 POST 条件查询 | 两者都可只读；不能按 HTTP verb 判 capability |
| 分页 | 单 Issue 不需要；列表 page/per_page | 查询 page_token，单页最多 500 | 首个 Gitee 切片无需分页状态机 |
| 错误模型 | 主要依赖 HTTP 与 JSON shape | HTTP + 业务 code，部分错误仍为 200 | 飞书需要额外 envelope contract |
| 公开验收样本 | 有 | 无；需要专用应用和资源授权 | Gitee 可在 CI 外做可重复 smoke |
| 动态字段/敏感数据 | 固定 Issue 字段 | 字段类型和权限动态变化 | 飞书应在 `AdapterManifest v1` 后验证 |
| 写入边界 | 本切片不提供 | 本切片不提供 | 两者都只声明 read capability |

## 公开只读探针

使用 Gitee 官方公开仓库 `oschina/git-osc`：

```text
GET https://gitee.com/api/v5/repos/oschina/git-osc
GET https://gitee.com/api/v5/repos/oschina/git-osc/issues/I4
```

核验结果：

- 两个请求均匿名返回 HTTP 200；
- 仓库返回 `full_name: oschina/git-osc`；
- Issue 返回 `id: 4`、`number: I4`、`repository.full_name: oschina/git-osc`、HTTPS `html_url` 以及可解析的创建/更新时间；
- 响应头观察到 `X-RateLimit-Limit: 60`。这是一次运行证据，不是稳定产品契约；实现只能按实际响应处理 429/限流，不能把 60 硬编码。

公开样本 `I4` 创建于 2013 年，适合真实 smoke；自动化 contract test 仍必须使用本地 fake，不得让全量测试依赖外网可用性。

## Gitee 最小 read contract

### `provider.health`

- 输入：规范化后的 `owner/repo`；
- 行为：匿名读取一个精确仓库；
- 成功：HTTP 200、合法 JSON、返回 `full_name` 与配置精确匹配；
- 失败：认证、权限、404、429、5xx、响应过大、JSON 或 scope 不匹配均返回安全错误；
- 输出：只含 provider、scope、状态和检查时间，不含 raw body/header。

### `work-item.read`

- 输入：规范化后的 `owner/repo`、区分大小写的 Issue `number`、显式 WorkItem mapping；
- 行为：只调用单 Issue GET；
- 成功：返回裁剪后的 ProviderSnapshot v2 Issue fact；
- 身份：`gitee:issue:{canonical-owner}/{canonical-repo}#{number}`；`externalId` 使用同一个 repository-scoped、区分大小写的 Issue reference，不假设响应整数 `id` 具备未文档化的全局唯一性；
- revision：以合法 `updated_at` 为 revision ID/occurredAt，并由裁剪事实生成 content digest；
- URL：只接受无凭证、无 query/fragment、host 为 `gitee.com` 且 path 与 scope/number 精确匹配的 HTTPS URL；
- candidate：生成带完整 scope/revision/managedFields 的 rich ExternalLink candidate，不生成新的 legacy Gitee link；candidate 仍只是读模型，当前领域 direct append 必须拒绝；
- 写入：网络写入、journal apply、Issue transition/comment/close 均为 0。

repository rename 或 Issue move 会改变 scoped identity，首版视为显式 mapping drift，不自动把它与旧 ExternalLink 合并。

## 停止条件

出现以下任一情况时，GitHub Issue `#10` 应停止在 fake contract，不声称真实 Gitee 接入完成：

- 公开仓库或样本不再允许匿名读取，且没有新授权的最小只读凭证方案；
- API 返回的 repository、number、URL 或 scoped identity 无法与请求精确对账；
- 必须把 token 放入 snapshot、错误、日志或持久化状态；
- Gitee 需要修改 WorkItem、Evidence 或 Acceptance 的业务不变量才能表达单 Issue；
- 为了一个 Issue read 必须先建立远程代码加载、通用 SDK 市场或写 capability。

## 未知与后续

- Gitee 私有仓库的安全认证传输和最小 scope 尚未验证；首个切片仅匿名公开读取。
- Gitee PR、CI/Check、Webhook、限流重试和写操作不属于第二 Provider 的最小契约。
- Gitee Check conclusion 的完整枚举和可重复真实 Evidence 样本尚未确认；不能从匿名空列表推断交付闭环已完成。
- 飞书真实 token、文档权限、动态字段 mapping 和单记录样本尚未提供，已迁移到 Linear `NP-11` 与前置任务 `NP-13`；资源访问路径及权限冲突见 `docs/research/0005-feishu-readonly-resource-access.md`。
- 运行时动态加载第三方代码、插件签名、沙箱、版本分发和市场治理没有证据支持，继续不做。
