# 调研 0005：飞书只读资源访问路径

## 研究范围

本调研支持 Linear `NP-13` 的资源准备决策：TaskSeal 应如何在不保存短期
access token、不申请记录写权限的前提下，让自动化进程读取一个由操作者准备的
飞书多维表格。

核验日期为 2026-07-29。证据只来自当前仓库和飞书开放平台官方文档；本次没有
使用飞书凭证、访问真实 Base 或修改任何飞书对象。

决策状态：操作者已于 2026-07-29 选择方案 A。Linear `NP-13` 已把原来的
“无机器人”约束收敛为“机器人能力只作为文档访问身份，零消息权限、零消息订阅、
零消息行为”。真实应用和 Base 尚未准备，因此该决策不构成只读 smoke 证据。

必须回答的问题：

1. 自建应用如何取得适合无人值守进程使用的访问凭证；
2. 字段、分页查询和单记录读取分别需要哪些最小权限；
3. 应用如何获得操作者创建的测试 Base 的文档访问权；
4. 当前 `NP-13` 的“无机器人”约束是否与访问路径兼容。

停止条件是确认一条权限边界自洽的路径，或找到必须由操作者选择的权限冲突。

## 研究结论

原 `NP-13` 的两个约束存在冲突：

- 任务要求使用 App ID/Secret，让进程以自建应用身份取得
  `tenant_access_token`；
- 任务同时排除机器人能力，但飞书官方的[权限概述][permission-overview]说明，
  应用使用 `tenant_access_token` 访问其他用户拥有的文档时，需要启用机器人能力，
  再由文档所有者把它添加为文档应用。

操作者已选择方案 A 并修改 `NP-13`：允许为专用测试应用启用机器人能力，但不申请
消息 API 权限、不订阅消息事件、不发送或读取消息，只把应用作为 Base 的文档访问
主体。这个选择保留应用身份、短期 tenant token 和无人值守执行模型，也不授予记录
创建、更新或删除能力。

如果“无机器人”是不可变约束，则应改用 `user_access_token`。这会新增用户 OAuth、
授权码、refresh token、用户离职/撤权和长期凭证轮换边界，不再是当前最快验证路线。

置信度为高，适用于飞书自建应用读取“用户拥有”的 Base。应用自有资源、商店应用、
知识库内 Base 或租户特殊安全策略仍需独立验证。

## 关键证据

| 主张 | 类型 | 证据 | 日期或版本 | 限制 |
| --- | --- | --- | --- | --- |
| 自建应用可用 App ID/Secret 调用 `/open-apis/auth/v3/tenant_access_token/internal/` 获取 tenant token | 事实 | [飞书调用 API 指南][api-call-guide] | 2026-07-29 核验 | token 实际响应仍需真实 smoke |
| tenant token 以应用身份访问数据，其范围由应用权限和资源授权共同决定 | 事实 | [飞书通用参数][terminology]、[权限概述][permission-overview] | 2026-07-29 核验 | 不代表仅有 API scope 就能读取任意文档 |
| tenant token 读取用户拥有的文档需要机器人能力并由所有者添加为文档应用 | 事实 | [权限概述][permission-overview] | 2026-07-29 核验 | 高级权限 Base 可能还需额外角色授权 |
| 新细粒度只读权限可覆盖表、字段、特定记录和条件查询 | 事实 | [API 权限列表][scope-list] | 2026-07-29 核验 | 租户管理员仍可能需要审批应用版本 |
| 旧 `GET /records` 已不推荐，官方建议使用 `POST .../records/search` | 事实 | [列出记录][list-records]、[查询记录][search-records] | 列出记录页面最后更新 2024-09-18 | HTTP POST 在这里是只读查询，不能按 verb 推断写能力 |
| 查询记录使用 `page_token`，单页最多 500 条 | 事实 | [查询记录][search-records] | 2026-07-29 核验 | 真实 token 续期、限流和分页漂移仍需 smoke |
| 记录 `fields` 是字段名到动态 union 值的 map | 事实 | [数据结构概述][bitable-structure] | 页面最后更新 2025-07-21 | 人员、附件等类型可能需要额外权限，应避免进入最小样本 |
| HTTP 成功不能替代业务成功，响应还需检查 `code === 0` | 事实 | [列出数据表][list-tables] | 页面最后更新 2025-07-21 | 每个端点的错误表需在 Adapter contract 中分别覆盖 |

## 候选方案

| 方案 | 优势 | 代价 | 主要风险 | 适用条件 |
| --- | --- | --- | --- | --- |
| A. tenant token + 仅启用机器人能力作为文档应用（已选择） | 无人值守；短期 token；权限可收敛到 Base 只读 scope | 需要修订 `NP-13` 的“无机器人”字面约束 | 若误加消息权限或事件订阅会扩大能力 | 接受“启用能力但零消息权限、零消息行为” |
| B. user token + OAuth | 不需要把应用作为机器人添加到 Base | 需要用户授权、refresh token 安全存储和撤权处理 | 用户身份漂移、长期凭证泄漏、试点退出后失效 | “无机器人”为硬约束且接受用户身份运行 |
| C. 应用先创建自有 Base 再撤销写权限 | 后续 tenant token 可直接访问应用自有资源 | 资源初始化必须临时申请创建/写权限，并建立撤权证据 | 与当前零记录写入范围冲突；权限回收不完整 | 另立受控 provisioning 任务并显式批准临时写权限 |

方案 C 目前不是建议路径。仓库没有受控飞书写入合同，不能为了准备测试数据绕过
TaskSeal 的只读边界。

## 方案 A 的最小权限

方案 A 只允许专用测试应用申请以下细粒度权限：

| Scope | 用途 |
| --- | --- |
| `base:table:read` | 对账 `app_token` 下的精确 `table_id` |
| `base:field:read` | 读取动态字段定义并验证字段映射 |
| `base:record:read` | 按 `record_id` 读取精确样本 |
| `base:record:retrieve` | 使用查询记录验证分页 |

明确不申请 `base:record:create`、`base:record:update`、
`base:record:delete`、消息 API 权限、消息事件或 broad legacy
`bitable:app` 权限。机器人能力本身不得转换成 TaskSeal
`message.read`、`message.write` 或其他未声明 capability。

## 预期环境契约

真实值只进入执行机的安全环境或 secret store。仓库、Linear、日志、错误和 snapshot
只允许出现变量名与配置完成事实：

| 环境变量 | 敏感性 | 用途 |
| --- | --- | --- |
| `TASKSEAL_FEISHU_APP_ID` | secret reference | 自建应用标识 |
| `TASKSEAL_FEISHU_APP_SECRET` | secret | 换取短期 tenant token |
| `TASKSEAL_FEISHU_APP_TOKEN` | 非凭证坐标 | 专用测试 Base |
| `TASKSEAL_FEISHU_TABLE_ID` | 非凭证坐标 | 专用测试 Table |
| `TASKSEAL_FEISHU_RECORD_ID` | 非凭证坐标 | 单记录 smoke 样本 |
| `TASKSEAL_FEISHU_TITLE_FIELD` | 非敏感 mapping | WorkItem 标题字段名 |
| `TASKSEAL_FEISHU_STATUS_FIELD` | 非敏感 mapping | Provider 本地状态字段名 |
| `TASKSEAL_FEISHU_UPDATED_AT_FIELD` | 非敏感 mapping | 来源更新时间字段名 |

Adapter 应自己获取并仅在内存中缓存短期 tenant token；不接受把
`tenant_access_token` 写入项目配置、Linear 或持久 journal。

## 资源准备清单

以下步骤由拥有目标飞书测试租户管理权限的操作者执行：

1. 创建仅用于 TaskSeal smoke 的自建应用，不复用生产应用。
2. 启用机器人能力作为文档应用身份，但不添加任何消息 API 权限、不配置消息事件、
   不发送或读取消息。
3. 只申请 `base:table:read`、`base:field:read`、`base:record:read` 和
   `base:record:retrieve`，完成目标租户要求的版本发布与管理员审批。
4. 创建专用测试 Base 和 Table。建议字段为 `Task Key`（文本）、`Title`（文本）、
   `Status`（单选）、`Updated At`（日期时间），并增加一个不参与 mapping 的非敏感
   字段以验证 Adapter 忽略未声明字段。
5. 准备至少 3 条无个人信息、无附件、无生产内容的记录；NP-11 使用
   `page_size = 2` 强制验证分页。
6. 由 Base 所有者把专用应用添加为文档应用。首个样本不开启高级权限；如果租户策略
   强制启用高级权限，应先记录精确只读角色并重新审查权限边界。
7. 在执行机的安全环境或 secret store 配置上表中的环境变量；不把真实 App Secret
   或 tenant token 粘贴到 shell 历史、仓库、Linear、截图或日志。
8. 在 `NP-13` 只评论“变量已配置”和非敏感坐标；真实 secret/token 不得进入票据。

## 未知项与验证方式

- **租户审批**：应用版本和细粒度 scope 是否需要管理员审批，只能在目标测试租户中
  核验；未获批时保持 `NP-11` Backlog。
- **高级权限**：如果 Base 开启高级权限，应用可能需要额外的角色授权；首个样本应
  关闭高级权限，或把精确角色要求记录为新的只读前置。
- **token 响应与续期**：真实 `expire`、错误 envelope 和提前刷新行为由
  mocked-real contract 加一次只读 smoke 验证，不从文档推断。
- **分页**：准备至少 3 条非敏感记录，以 `page_size = 2` 强制出现第二页，避免为了
  分页测试创建 501 条记录。
- **动态字段**：样本只使用文本、单选和日期等非人员字段；增加一个不参与 mapping
  的额外字段，验证 Adapter 会忽略未声明字段而不是保存整个 `fields`。
- **撤权**：smoke 后移除文档应用或停用测试应用，并确认旧 token 不能继续读取。

## 建议下一步

1. 已完成：操作者选择方案 A。
2. 已完成：更新 `NP-13`，把“无机器人”改为“零消息权限、零消息订阅、零消息行为”。
3. 待操作者完成：按资源准备清单创建专用资源并配置执行机变量。
4. 资源就绪后再把 `NP-11` 移入 Todo/In Progress，并实现 token、table、field、page、
   record 与业务 `code` 的 mocked-real contract 和真实只读 smoke。
5. 真实证据完成前，`NP-13` 与 `NP-11` 均不得标记 Done。

[api-call-guide]: https://open.feishu.cn/document/server-docs/api-call-guide/calling-process/get-?lang=zh-CN
[terminology]: https://open.feishu.cn/document/server-docs/api-call-guide/terminology?lang=zh-CN
[permission-overview]: https://open.feishu.cn/document/server-docs/docs/permission/overview
[scope-list]: https://open.feishu.cn/document/server-docs/application-scope/scope-list?lang=zh-CN
[list-tables]: https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table/list?lang=zh-CN
[list-records]: https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/list?lang=zh-CN
[search-records]: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/bitable-v1/app-table-record/search
[bitable-structure]: https://open.feishu.cn/document/server-docs/docs/bitable-v1/bitable-structure
