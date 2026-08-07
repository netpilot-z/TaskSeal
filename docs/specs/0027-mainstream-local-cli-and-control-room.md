# 规格 0027：主流本地 CLI、配置权威与 Control Room

## 背景

TaskSeal 已经验证 WorkItem、Attempt、Artifact、Evidence、AcceptanceDecision 与
Provider sync 可以形成可复核闭环，但安装后的日常 Interface 仍要求操作者理解过多
Implementation 细节：

1. 源码运行仍是主要入口，安装后不能通过一个稳定命令进入工作区。
2. 项目坐标、Runner 参数、本机偏好和凭证状态分散在项目配置、环境变量与命令参数中。
3. CLI 缺少 `config`、`status`、`open` 和面向 WorkItem 的高频查询入口。
4. Control Room 把营销式 Hero、Runner 表单与 Acceptance 控件放在首屏，正在运行、
   需要人工处理和系统健康反而需要向下寻找。
5. Control Room 没有 Settings Interface，也无法解释 effective value 的来源。

本规格把 TaskSeal 收敛为一个本地优先产品：CLI 负责安装后的 bootstrap、自动化和快速
查询；loopback Control Room 负责可视化配置、运行态观察、Evidence 审查与人工验收；
两者调用同一 application-owned Module。

外部 Interface 参考当前 Codex CLI 的分层配置、doctor、JSON 与恢复入口，以及
Claude Code 的 user/project/local scope、doctor、status 与后台任务查询。TaskSeal 只
采用这些成熟的交互合同，不复制两者的 Agent 执行模型：

- <https://learn.chatgpt.com/docs/config-file/config-basic>
- <https://learn.chatgpt.com/docs/developer-commands?surface=cli>
- <https://code.claude.com/docs/en/settings>
- <https://code.claude.com/docs/en/cli-usage>

## 目标

- 安装后通过一个主命令进入初始化、配置或 Control Room。
- 常见配置无需手工编辑 JSON，同时继续支持可审查的项目配置。
- 每个 effective configuration 字段都能解释来源、可编辑 scope 与重启影响。
- `doctor`、`start`、Setup 页面和 Settings 页面复用同一 Readiness 结论。
- CLI `status --json` 与 Control Room 使用同一运行态投影。
- 首屏直接展示 Running now、Needs attention 与 System health。
- Web 与人类可读 CLI 输出支持 English 和简体中文切换。
- 保持 Agent completed 不等于 WorkItem accepted、Runner 默认只读、外部写显式审批、
  Provider provenance 与单 writer 等已接受不变量。
- 新 Interface 以 additive migration 落地，旧命令和 v1 项目配置保留兼容窗口。

## 非目标

- 不引入后台 daemon、OS service、桌面客户端或远程公开监听。
- 不引入 SQLite、Postgres、Redis、消息队列或多 writer。
- 不构建登录、RBAC、多租户、远程团队服务或 Secret Vault。
- 不为了展示多 Runner 而新增 Claude Code Adapter。
- 不把页面改写成 React、Vue 等新框架，不新增生产依赖。
- 不在首版实现运行中热重载、Attempt resume 或跨进程增量流。
- 不改变 Domain event、journal、Provider SDK 或 Runner SDK persisted contract。

## 产品形态

### 安装与主入口

发布 preview 包后，目标路径为：

```text
npm install -g taskseal@preview
cd <repository>
taskseal
```

裸 `taskseal` 的行为由终端类型和 Readiness 决定：

| 条件 | 行为 |
| --- | --- |
| TTY，项目未初始化或 core not-ready | 启动受限 SetupRuntime 并打开 Setup 页面 |
| TTY，项目 ready | 启动或连接现有 Control Room 并打开浏览器 |
| 非 TTY，无显式子命令 | 输出简洁帮助并返回 usage error |
| 已有可验证的本地实例 | 复用实例，不争抢 writer lock |
| lock 来源无法验证 | 失败关闭，不自动删除 lock |

格式完整的 schema v2 lock 若由 OS PID probe 明确证明 owner 已退出，属于可验证的陈旧锁；
`start` 可以在再次核对内容未变化后回收并重试一次。PID 仍存活、旧版、损坏、权限不明或
并发变化的 lock 不属于该例外。已有实例必须通过 loopback endpoint 与随机 instance ID
回读验证后，`start` 才以“已在运行”返回成功，避免包管理器把幂等启动显示为失败。

`taskseal start` 保持规格 0026 的 fail-closed 语义。无头环境使用
`taskseal start --no-open`；`taskseal setup` 显式进入 SetupRuntime；
`taskseal open` 只打开已验证实例。

### CLI Interface

默认帮助只展示高频命令：

```text
taskseal
taskseal init
taskseal setup
taskseal doctor [--connect] [--json]
taskseal status [--watch] [--json]

taskseal config list
taskseal config get <key>
taskseal config set <key> <value> [--scope user|project|local]
taskseal config unset <key> [--scope user|project|local]
taskseal config edit <user|project|local>
taskseal config validate [--json]

taskseal work list [--json]
taskseal work show <work-item> [--json]
taskseal work run <work-item> [--read-only|--workspace-write]
taskseal work cancel <work-item>
taskseal work retry <work-item> [--read-only|--workspace-write]

taskseal integration list [--json]
taskseal integration setup <provider>
taskseal integration test <provider>
taskseal integration disable <provider>

taskseal start [--no-open]
taskseal open
taskseal completion <shell>
```

全局参数：

```text
-C, --workspace <path>
--json
--no-color
--quiet
--lang <auto|en|zh-CN>
--help
--version
```

领域名称固定为 `WorkItem`。CLI 使用 `work`，页面使用 `Work Items`，不新增与
WorkItem 重叠的 `Task` 业务概念。

现有 `inspect`、`ready`、`reconcile`、`sync` 与 `plugin check` 作为高级兼容命令
至少保留一个发布周期，但不占据默认帮助首屏。

### 输出与错误合同

- 人类输出默认简洁、分组、带直接修复建议。
- 人类输出根据 resolved locale 使用 English 或简体中文。
- 所有只读查询支持稳定、版本化的 `--json` envelope。
- JSON key、enum、error code、message key 与 ISO timestamp 不随 locale 改变。
- stdout 只输出结果；stderr 输出诊断和进度。
- 退出码继续使用 `0` 成功、`1` 运行或策略失败、`2` usage error。
- usage error 必须在打开 journal、读取凭证或访问网络前返回。
- 错误不得包含 Secret、Provider 原始正文、stack 或开发者机器绝对路径。
- Control Room 端口冲突必须映射为 `CONTROL_ROOM_PORT_UNAVAILABLE`，释放 writer lock，
  并给出 `config set runtime.port` 修复入口；显式端口不得静默 fallback。
- Control Room lock 存在时，CLI 配置命令必须通过 lock 公布的 loopback endpoint 转交；
  响应的随机 instance ID 必须与 lock 一致。旧版、损坏、重定向、超时或身份不符固定返回
  `CONTROL_ROOM_HANDOFF_UNAVAILABLE`，不得退回本地写入。

稳定错误码至少包括：

```text
PROJECT_NOT_FOUND
CONFIG_INVALID
CONFIG_REVISION_CONFLICT
CONFIG_PLAN_STALE
CONFIG_FIELD_NOT_OVERRIDABLE
CONFIG_RESTART_REQUIRED
CONTROL_ROOM_PORT_UNAVAILABLE
CONTROL_ROOM_HANDOFF_UNAVAILABLE
CREDENTIAL_MISSING
RUNTIME_NOT_READY
CONTROL_ROOM_LOCKED
CONTROL_ROOM_LOCK_UNVERIFIED
WORK_ITEM_NOT_FOUND
WORK_ITEM_BLOCKED
REVIEW_REQUIRED
REVIEW_STALE
EXTERNAL_FACT_DRIFT
```

## Configuration Control Module

### External Seam

CLI、Setup 页面、Settings 页面、`doctor` 与 `start` 只通过两组入口访问配置：

```ts
inspect(context): ConfigurationView
preview(change, expectedRevision): ConfigurationPlan
apply(planDigest, expectedRevision): ConfigurationReceipt

readDraft(scope): ConfigurationDraft
previewDraft(document, expectedRevision): ConfigurationDraftPlan
applyDraft(planDigest, expectedRevision): ConfigurationReceipt
```

CLI 通过传输无关的 `ConfigurationAuthority` 使用 Local 与 Running-instance 两个真实 Adapter。
运行实例 Adapter 固定使用 loopback、禁止 redirect、限制响应大小和时限，并复用 Control Room
既有 Host、Origin 与 CSRF 写请求门禁。

`ConfigurationView` 返回：

- effective configuration；
- 每个字段的 source、editable scope、sensitivity 与 restart impact；
- credential binding 的 `present`、`missing` 或 `unavailable` 状态；
- desired revision 与当前 Control Room active revision；
- 字段级诊断和整体 Readiness。

`ConfigurationPlan` 返回规范化 diff、诊断、重启影响和 plan digest，不包含 Secret。
`apply` 同时核对 expected revision 与 plan digest，冲突时零写入，并使用原子替换。
`ConfigurationDraft` 用于多个相互依赖字段的一次编辑；草稿只存在于权限受限的临时文件，
整个文档通过同一 schema 和安全策略校验后才可进入 `applyDraft`。Editor Adapter 使用参数数组
直接启动进程，不经过 shell；编辑失败、非法草稿和并发冲突均不得修改正式来源。

Configuration Control 隐藏：

- workspace/root 发现；
- defaults、user、project、local、environment 与 command source 解析；
- schema version union decode 与兼容迁移；
- 字段 scope policy 与安全交集；
- credential reference redaction；
- field source explanation；
- revision、diff、digest、CAS、原子写和 restart impact。

### 配置来源

普通可覆盖字段采用：

```text
command override
> environment
> local
> project
> user
> built-in defaults
```

| Source | 持久位置 | 用途 |
| --- | --- | --- |
| Built-in | 程序内 | 安全默认值 |
| User | 平台用户配置目录 | locale、浏览器、编辑器等个人偏好 |
| Project | `config/project.json` | 可提交的项目坐标、Provider scope、workflow 规则 |
| Local | `.taskseal/config.local.json` | gitignored 的本机端口、Runner 路径等非敏感值 |
| Environment | 进程环境 | Secret、CI 临时值和兼容入口 |
| Command | 当前调用内存 | 一次性非敏感覆盖 |

不是所有字段都允许出现在所有 scope。项目治理与安全能力不采用普通
last-write-wins：

```text
effective capability
= host policy
∩ project allowlist
∩ Adapter manifest
∩ current action request
∩ workflow approval
```

因此：

- User、Local、Environment 和 CLI 不能放宽 project Provider scope。
- `workspace-write` 只能由当前 Attempt 显式请求，不能持久化为默认值。
- 配置只能使 capability 可用，不能代表某次外部 mutation 已获批准。
- Adapter manifest 只声明能力，不授予权限。

### Credential binding

项目配置只保存逻辑引用：

```text
credential:linear.default
```

用户级 binding 只保存 resolver reference：

```text
linear.default -> env:LINEAR_API_KEY
```

首版只有 environment resolver，既有 `GITHUB_TOKEN`、`LINEAR_API_KEY`、
`GITEE_TOKEN`、`FEISHU_APP_ID` 与 `FEISHU_APP_SECRET` 继续作为兼容 binding。

Secret value 不得进入 argv、项目配置、local 配置、HTTP GET、journal、日志、错误或
浏览器存储。页面和 CLI 只显示 binding source 与 presence，不提供 Token 输入框、复制
按钮或明文回显。

## Runtime 与查询投影

### SetupRuntime

SetupRuntime 是独立 composition，不是降级版 OperationalRuntime。它只允许：

- 读取和初始化项目脚手架；
- 调用 Configuration Control；
- 调用 Runtime Readiness；
- 显示 credential presence；
- 在用户显式触发后执行有界、只读 connection probe。

它固定 loopback，不打开 canonical journal、Provider Operation Journal、Runner、
Acceptance、Decomposition 或任何外部写 Adapter，也不获取 Control Room writer lock。
配置变为 ready 后必须关闭 SetupRuntime，再由标准 `start` composition 重新评估并获取
writer lock；不得在同一进程内隐式升级。

### Operations Query

CLI 与 Control Room 使用同一个 application-owned 投影：

```ts
snapshot(query): ProjectOperationsView
```

首版 `status --watch` 使用有界 polling，不提前引入 SSE Seam。Control Room 运行时，CLI
读取已验证 loopback instance 的易失运行态；Control Room 未运行时，CLI 只重放持久
journal 并明确标记 `runtime: offline`，不能把历史 running Attempt 冒充为 live。

投影保持以下维度分离：

| 维度 | 说明 |
| --- | --- |
| Runtime health | setup、ready、degraded、stopped、fenced |
| WorkItem | planned、running、reviewing、blocked、accepted |
| Attempt | running、superseded、completed、failed、interrupted |
| Artifact/Evidence gate | 当前 Artifact revision 与 Required Evidence 是否成立 |
| Acceptance | 人工决定及绑定的 review revision |
| Provider sync | 远端观察、计划、执行和对账状态 |

Attempt completed 不得映射为 WorkItem accepted；Provider sync 失败不得覆盖本地
AcceptanceDecision。

## Loopback HTTP Interface

OperationalRuntime 与 SetupRuntime 复用输入 Adapter，但暴露的 capability 不同。

首版配置和查询路由：

```text
GET  /api/configuration
GET  /api/configuration/drafts/:scope
POST /api/configuration/change
POST /api/configuration/draft
POST /api/readiness/probe
GET  /api/status
GET  /api/work-items
GET  /api/work-items/:id
```

约束：

- 所有配置写必须携带 `expectedRevision`。
- `apply` 必须携带 preview 返回的 plan digest。
- HTTP 响应只包含安全、脱敏、版本化对象。
- SetupRuntime 对 operational route 固定返回 capability disabled。
- connection probe 默认零网络；只有显式 provider test 才进行有界只读请求。
- 浏览器不能直接读取配置文件或 journal。

## Control Room 信息架构

### 导航

```text
Overview
Work Items
Attempts
Integrations
Settings
```

Overview 首屏只回答：

1. Running now：当前 Attempt、耗时、Runner、workspace access 与取消入口。
2. Needs attention：等待验收、blocked、Evidence 缺失、配置错误与同步失败。
3. System health：Runtime、配置 revision、Runner、Provider 与 journal 状态。

Work Item 详情使用：

```text
Overview
Attempts
Artifact & Evidence
Acceptance
Audit
```

Integrations 分开显示：

```text
Configured
Credential present
Connectivity checked
Scope verified
Read capability
Write capability
Last observation
```

Settings 分为 General、Runner & Safety、Server、Integrations & Workflow 与 Advanced。
每个字段显示 effective value、source badge、editable scope、restart impact 和安全说明。
顶部 utility bar 与 Settings/General 都提供 `English / 简体中文` 切换，但共用同一个
user-scoped `ui.locale` 字段。

### 视觉与交互规则

界面采用现有 dark charcoal、lime accent 与 TS 标识，执行 targeted evolution，不重做品牌。
默认设计参数：

```text
DESIGN_VARIANCE: 5
MOTION_INTENSITY: 2
VISUAL_DENSITY: 7
```

`Leonxlnx/taste-skill` 明确把 dashboard、data table 与 multi-step product UI 列为
out of scope，因此不作为 TaskSeal 的完整设计系统或依赖。这里只选择性采用与控制台
相容的规则：

- 审计当前品牌、IA、内容块与可访问性后再调整。
- 首屏去除大面积营销式 Hero，优先 operational truth。
- 使用排版、间距、对齐和稀疏分隔组织信息，避免 cards inside cards。
- 页面只使用一个 lime accent，状态色只表达真实语义。
- 建立一致的 shape rule：panel 16px、field 10px、pill 只用于语义状态。
- 正文不小于 14px，辅助文本不小于 12px；monospace 只用于 ID、digest 与时间。
- 表单 label 位于输入框上方；loading、empty、error、disabled、stale 与 conflict 状态完整。
- CTA 文案不换行；交互元素具备明确 hover、active 与 focus-visible 状态。
- 动画只用于反馈和状态转换，只改变 transform/opacity，并尊重
  `prefers-reduced-motion`。
- 不使用 AI purple、无意义 glow、装饰性渐变、虚假百分比、过量 badge 或装饰性状态点。
- visible copy 不使用 em dash 字符，避免以标点制造设计感。

不新增 Fluent、Carbon、Tailwind 或图标生产依赖。首版继续使用现有静态 HTML、CSS
variables 与 JavaScript，并把复用样式收敛为项目内 tokens 和 patterns。

参考：

- <https://github.com/Leonxlnx/taste-skill>
- <https://github.com/Leonxlnx/taste-skill/blob/main/skills/taste-skill/SKILL.md>

## 国际化 Interface

### 支持范围

首版支持两个明确 locale：

```text
en
zh-CN
```

`zh`、`zh-Hans` 与中文浏览器首选项归一化为 `zh-CN`；其他不支持 locale 回退到 `en`。
English 是最终 fallback，确保缺失翻译不会让 Setup、doctor 或安全诊断不可用。

国际化只作用于 presentation：

- Web 导航、按钮、label、帮助、empty/error/loading 状态和可访问性文本；
- CLI help、doctor、status、config 与 work 的人类输出；
- 可安全本地化的 application diagnostic；
- 日期、时间和数字展示。

以下内容不翻译、不改写：

- WorkItem title、Runner assignment、Acceptance reason 等用户数据；
- Provider 返回的名称、repository、Issue title 和外部标识；
- WorkItem、Attempt、Provider operation 等 Domain enum；
- JSON key、schema、digest、UUID、error code、message key 与日志结构；
- shell command、配置 key、环境变量和文件名。

页面永远只把稳定 identifier 提交给 server，不能把已翻译 label 当作 command 或状态值。

### Locale resolution

User configuration 增加非敏感、无需重启的字段：

```json
{
  "ui": {
    "locale": "auto"
  }
}
```

允许值为 `auto`、`en`、`zh-CN`，只允许 User scope 与当前 command/session override，
不能写入 Project scope。解析顺序：

| Surface | Resolution |
| --- | --- |
| CLI | `--lang` > User `ui.locale` > OS locale > `en` |
| Setup page | 当前 session selection > process `--lang` > User `ui.locale` > browser locale > `en` |
| Control Room | 当前 session selection > process `--lang` > User `ui.locale` > browser locale > `en` |
| JSON/machine output | 固定 machine contract，不做文案本地化 |

`auto` 表示继续解析 browser 或 OS locale。页面切换语言后通过 Configuration Control
写入 User scope，并立即重新渲染 presentation；它不改变 active runtime revision，不要求
重启，也不能触发 Provider 网络或业务 journal 写入。

### Presentation I18n Module

建立独立 presentation-owned I18n Module，Interface 为：

```ts
resolveLocale(preferences): SupportedLocale
createPresentation(locale): LocalizedPresentation
```

`LocalizedPresentation` 负责 message key 插值以及基于标准 `Intl` 的 date、time 和 number
格式化。Catalog 只包含纯文本和安全 interpolation placeholder，不包含 HTML、脚本、
Markdown 或业务状态转换。

CLI Adapter 直接使用该 Module；Web Adapter 通过只读、版本化 catalog endpoint 获取同一
catalog，不复制第二套翻译。SetupRuntime 与 OperationalRuntime 暴露相同 endpoint：

```text
GET /api/presentation/catalog?locale=<en|zh-CN>
```

Application diagnostic 逐步收敛为：

```ts
{
  code: StableErrorCode;
  messageKey: PresentationMessageKey;
  params: SafePresentationParameters;
}
```

`params` 不得包含 Secret、Provider raw body 或开发者机器绝对路径。CLI 和 Web 在各自
presentation Adapter 中本地化；Domain、journal 和 machine JSON 不保存翻译后的句子。

### Catalog 与可访问性规则

- English 与简体中文 catalog 必须具有完全相同的 key set。
- English 文案是 source-of-truth fallback，但不是 Domain contract。
- 缺失 key 在开发和测试中失败；生产 fallback 到 English 并记录脱敏 diagnostic。
- 插值 placeholder 的名称和数量必须跨 locale 一致。
- `<html lang>`、页面 title、ARIA label、live region 和 validation message 随切换更新。
- 不允许只翻译可见按钮而遗漏 screen-reader-only 文案。
- 布局不能依赖 English 固定宽度；按钮在两种语言下都不能裁切或桌面换行。
- 日期和数字只在 presentation 使用 locale formatting；JSON 保持 ISO 8601 和标准数字。
- Catalog 随 npm package 一起发布，读取 catalog 不访问网络外部系统。

## 安全不变量

1. SetupRuntime、Settings save、config show 和普通 doctor 零 Provider 外部写。
2. `integration test` 只有用户显式调用时才产生有界只读网络请求。
3. Runner workspace access 默认 read-only；workspace-write 每次 Attempt 显式授权。
4. 配置 enablement 不替代 Provider mutation approval。
5. Secret value 不进入配置、HTTP、argv、日志、错误或 UI。
6. 运行中 Attempt 绑定启动时的 active config revision；desired config 不能改写它。
7. 首版 process-bound 配置（端口、模式、存储和 runner 能力）要求重启；Provider 非
   Secret 坐标按 operation revision 在下一次 operation 激活，in-flight operation 不漂移。
8. 页面不是第二 writer，只向持锁的 OperationalRuntime 或受限 SetupRuntime 提交命令。
9. WorkItem、Attempt、Evidence、Acceptance 和 Provider sync 不压成一个状态。
10. 项目文件、示例和诊断不得持久化开发者机器绝对路径。

## 兼容与迁移

- `config/project.json` 路径不移动，现有 v1 文件继续有效。
- 新 source 解析先把 v1 归一化到内存模型，不自动重写文件。
- schema upgrade 必须通过 preview 展示规范化 diff，不能静默发生。
- 旧 CLI 命令作为新 application Module 的兼容 Adapter 保留至少一个发布周期。
- 旧 `/api/dashboard` 与 `/api/providers` 可先从新投影反向适配，不立即删除。
- 新 UI 路由稳定前与现有页面并存；回退只需恢复默认入口。

## 验收标准

1. 新用户从安装到看到 Setup 或 Control Room 不超过三条命令。
2. 常见非敏感配置不需要手工编辑 JSON。
3. 每个 effective field 都能解释 source、scope 和 restart impact。
4. Secret 只显示 presence 和 binding source，任何响应中都没有 value。
5. `doctor`、`start`、Setup 和 Settings 对同一输入给出相同诊断。
6. `status --json` 与 Control Room 使用同一 ProjectOperationsView。
7. offline status 不声称历史 Attempt 正在实时运行。
8. Overview 首屏可见 Running now、Needs attention 与 System health。
9. WorkItem、Attempt、Evidence、Acceptance 和 Provider sync 语义继续分离。
10. SetupRuntime 无 journal、Runner、Acceptance、Decomposition 和 Provider write capability。
11. 旧 v1 配置、旧命令和 persisted journal 在兼容窗口内无回归。
12. 全量测试、package install smoke、桌面与窄屏浏览器 QA 通过。
13. Web 和人类 CLI 输出可在 `en` 与 `zh-CN` 间切换，切换无需 runtime restart。
14. 两个 catalog key 与 interpolation placeholder 完全一致，缺失翻译在测试中失败。
15. `--json`、Domain enum、error code、配置 key 与 persisted contract 在两种 locale 下
    byte-for-byte 相同。
16. `<html lang>`、ARIA、live region、日期和数字格式随 locale 正确更新，用户数据不被翻译。
