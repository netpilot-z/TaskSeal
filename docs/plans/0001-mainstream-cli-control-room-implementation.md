# 实施计划 0001：主流 CLI、配置与 Control Room

## 目标

按规格 0027、ADR 0019 与 ADR 0020，以可审查、可验证、可回滚的小切片交付安装后配置、
状态查询和 operations-first Control Room。每个切片只有一个写入者；中大型切片完成后
分别执行 verification 与 review-diff。

## 当前进度（2026-08-03）

- Phase 0 已完成。
- Slice 1.1 已完成：Configuration Control 统一只读投影，Runtime Readiness 已迁移。
- Slice 1.2 已完成：User `ui.locale`、Local `runtime.port`、Environment/Command 优先级，
  以及 `config list/get/validate --json`。
- Slice 1.3 的离线安全写核心已完成：preview digest、revision CAS、workspace/User 写锁、
  原子替换、幂等 apply、`config set/unset`，以及多字段 `config edit` 的临时草稿和无 shell
  Editor Adapter。运行实例转交也已完成：lock v2 的 loopback endpoint/instance ID、Local 与
  Running-instance Adapter、CSRF HTTP 写入口和 fail-closed handoff；stale/tampered plan、
  并发 writer、无效 editor 草稿和 instance identity 不匹配均已有回归门禁。
- Slice 2.3 已完成当前范围：`en`/`zh-CN` catalog、locale resolution、`Intl`、配置命令与
  `doctor` 双语输出、Web catalog endpoint，以及 Control Room/Settings 语言切换。
- Phase 4 的 Settings 切片已完成：字段元数据、配置来源、完整 Project 草稿保存、active 与
  desired runtime revision 对比、重启提示，以及面向桌面和窄屏的响应式界面。
- Phase 4 的易用性复核已完成实现：Project 基础与 Provider 连接分组、官方访问设置入口、
  仅 presence 的凭据状态、shadcn 风格原生组件契约、不可用人工门禁解释，以及可复制的
  重启命令；真实 OAuth 依 ADR 0022 暂缓到具备注册应用和安全 token storage 后。
- Phase 4 的 Dashboard 密度与窄屏复核已完成：工作流摘要前置到首屏、未配置人工操作人时
  收敛为单一可操作提示、390px header 无横向溢出，并补齐 Runner、Provider、snapshot 与
  orchestration live region 的中英文 presentation boundary。
- Phase 2 的渐进帮助先完成当前 CLI 路由切片：`help <command>`、`<command> --help` 与
  GitHub/Linear/飞书/Gitee 的无凭据配置模板；模板生成在配置解析、文件读取和网络访问前
  返回，JSON 输出使用稳定 `configuration-template/v1` envelope。
- 启动端口故障已完成回归修复：内置默认端口从高冲突的 OTLP 端口迁移到 `7331`；
  `EACCES`/`EADDRINUSE` 映射为双语 `CONTROL_ROOM_PORT_UNAVAILABLE`，并确认失败释放
  Control Room lock。显式配置端口保持确定性，不做静默 fallback。
- 当前交付切片已完成独立 verification 与 review-diff：全量测试、npm/pnpm package install
  smoke、桌面/窄屏浏览器 QA、双语时间格式、静态脚本检查和工作树 hygiene 均已通过。

## 总体顺序

```text
Configuration Control
-> CLI read-only queries
-> SetupRuntime
-> safe config writes
-> Control Room information architecture
-> packaging and onboarding
```

不能先做 Settings 表单再补配置权威，也不能先放宽 `start` 再补 SetupRuntime 安全限制。

## Phase 0：规格与门禁

交付：

- `docs/specs/0027-mainstream-local-cli-and-control-room.md`
- `docs/adr/0019-application-owned-configuration-authority.md`
- `docs/adr/0020-restricted-setup-runtime.md`
- `docs/adr/0021-bilingual-presentation-contract.md`
- 本计划

门禁：

- 与规格 0026、ADR 0018、Runner 默认只读和外部写审批不冲突。
- 不修改生产代码、persisted schema 或外部系统。

回滚：删除新增文档即可，不影响运行时。

## Phase 1：Configuration Control Foundation

### Slice 1.1：只读 ConfigurationView

范围：

- 新建 application-owned Configuration Control Module。
- 包装现有 `readProjectConfiguration`，不改变 v1 schema。
- 返回 effective fields、source、editable scope、sensitivity、diagnostic 和 revision。
- Runtime Readiness 改为消费同一 decoded view，删除重复解析。

测试：

- v1 配置归一化 golden tests。
- unknown field、invalid type、cross-field diagnostic。
- credential value 不出现在 view、JSON 与错误中。
- `doctor` 与 `start` 对同一 fixture 结论一致。

门禁：`npm run typecheck`、定向测试、全量测试。

回滚：保留兼容 wrapper，可恢复 Readiness 旧调用，不涉及文件迁移。

### Slice 1.2：User 与 Local source

范围：

- 增加平台 user source 和 `.taskseal/config.local.json`。
- 为每个字段声明 allowed scopes、restart impact 与 security policy。
- 增加 User-only `ui.locale: auto|en|zh-CN`，locale change 不要求重启。
- 普通字段实现 precedence；安全字段实现更严格交集。
- 增加 `taskseal config list/get/validate --json`，只读、零网络。

测试：

- precedence matrix。
- project scope 不能被 user/local/command 放宽。
- workspace-write 持久配置固定拒绝。
- 项目输出不含本机绝对路径。

门禁：CLI JSON contract snapshot 与 package install smoke。

回滚：未创建 user/local 文件时行为与 v1 一致。

### Slice 1.3：Preview、apply 与 atomic write

范围：

- 实现 typed change、preview digest、expected revision、CAS 与原子替换。
- 增加 `config set/unset/edit`。
- runtime-affecting change 返回 `restartRequired`。
- 运行实例存在时，CLI 转交给已验证 loopback instance；离线时使用配置写锁。

测试：

- stale revision、stale digest、invalid diff 均零写入。
- exact retry 幂等。
- crash-safe atomic replace。
- 两个 writer 竞争只有一个成功。
- Secret field 不能通过 set/edit/apply 提交。

门禁：文件故障注入测试、review-diff、安全审查。

回滚：写入格式仍为 v1 JSON；不做自动 schema upgrade。

## Phase 2：CLI Product Surface

### Slice 2.1：命令路由与渐进帮助

范围：

- 增加裸入口、`setup`、`status`、`work`、`integration`、`open`、`completion` 路由。
- 拆分默认帮助、子命令帮助和 advanced help。
- 统一 `-C`、`--json`、`--no-color`、`--quiet`。
- 增加 `--lang auto|en|zh-CN`，不改变 `--json` machine contract。
- 保留旧命令兼容 Adapter。

测试：

- usage error 在 I/O、凭证读取和网络前失败。
- stdout/stderr 分离。
- 退出码和稳定错误码。
- 旧命令行为无回归。

### Slice 2.2：Operations Query

范围：

- 建立统一 `ProjectOperationsView`。
- `status`、`work list/show` 与 `/api/status` 使用同一投影。
- 运行实例提供 live overlay；离线重放明确标记 runtime offline。
- `status --watch` 首版使用有界 polling。

测试：

- live 与 offline fixture。
- 历史 running Attempt 离线时不显示为 active。
- Agent completed 不映射为 accepted。
- Provider sync failure 不覆盖 AcceptanceDecision。

门禁：投影 contract tests、CLI/server parity tests、全量测试。

### Slice 2.3：Presentation I18n Module

范围：

- 建立 `resolveLocale` 与 `createPresentation` Interface。
- 建立 `en`、`zh-CN` catalog 和只读 catalog endpoint。
- 先迁移 common help、doctor、status、config 与 work 的人类输出。
- Application diagnostic 迁移为 stable code、messageKey 与 safe params。
- 日期、时间和数字使用内置 `Intl`；JSON 保持 ISO 和稳定数字。

测试：

- catalog key parity 与 interpolation placeholder parity。
- locale normalization、unknown locale fallback 与 `auto` resolution。
- 两种语言的 CLI human snapshot。
- 两种 locale 的 `--json` 输出 byte-for-byte 相同。
- missing key 在测试中失败，生产 fallback 不泄露敏感 diagnostic。

门禁：presentation Interface tests、CLI snapshot、package catalog smoke、review-diff。

## Phase 3：SetupRuntime

### Slice 3.1：受限 composition

范围：

- 新建 SetupRuntime composition 与静态 Setup 页面入口。
- 固定 loopback；只组合 Configuration Control 与 Runtime Readiness。
- operational routes 使用显式 capability allowlist 固定拒绝。
- 裸 `taskseal` 根据 TTY 和 core Readiness 选择 setup 或 operational。

测试：

- not-ready 时 journal、Runner、Acceptance、Decomposition 与 Provider write 构造次数为零。
- non-loopback listen 固定拒绝。
- operational route 返回稳定 `CAPABILITY_DISABLED`。
- ready 后 SetupRuntime 终止，再由标准 start 获取 writer lock。

### Slice 3.2：Read-only integration probe

范围：

- 增加显式 `integration test` 与 `/api/readiness/probe`。
- 默认 readiness 只做本地检查；provider probe 有 deadline、response bound 与 redaction。
- 复用 Provider health/read capability，不构造 write transport。

测试：

- 页面 load、config show/save 与默认 doctor 网络次数为零。
- test 只访问选定 Provider，且外部写次数为零。
- timeout、credential missing、foreign scope 与 raw error redaction。

门禁：外部系统默认只读审查、网络故障测试、review-diff。

## Phase 4：Control Room targeted evolution

### Visual gate

在修改 UI 前，基于现有桌面和窄屏截图形成三个独立视觉方向，并选择一个作为 visual
target。默认产品方向为 operations-first application shell，不把 `taste-skill` 的营销页
模式应用到 dashboard。

设计基线：

```text
DESIGN_VARIANCE: 5
MOTION_INTENSITY: 2
VISUAL_DENSITY: 7
```

### Slice 4.1：应用壳与 Overview

范围：

- 增加 Overview、Work Items、Attempts、Integrations、Settings 导航。
- utility bar 与 Settings/General 增加 `English / 简体中文` 切换。
- 去除首屏大 Hero，把 Running now、Needs attention、System health 提到首屏。
- 不改变既有 DOM ID、操作语义和 analytics-like hooks，除非测试覆盖迁移。
- 保留现有 dark charcoal、lime accent 与 TS mark。

验收：

- 1440x1024 首屏无需滚动即可找到 active Attempt、等待验收和 runtime health。
- 768px 和 320px 明确单列重排，无水平溢出。
- 正文至少 14px，辅助文本至少 12px。
- 不出现 nested card、装饰性 gradient、无意义 glow 或过量 pill。

### Slice 4.2：Work Items 与 Attempts

范围：

- WorkItem 行明确分列 canonical state、active Attempt、Evidence、Acceptance 和 Provider sync。
- 详情使用 Overview、Attempts、Artifact & Evidence、Acceptance、Audit。
- 原始 UUID、digest 和长诊断进入 disclosure，不占据 primary scan path。
- primary action 根据状态唯一化，例如 Review delivery、Cancel attempt 或 Retry。

验收：

- Attempt completed 与 WorkItem accepted 视觉上不会混淆。
- waiting review、blocked、failed、offline、stale 和 empty 状态都有专用呈现。
- CTA 桌面不换行，键盘焦点顺序符合视觉顺序。

### Slice 4.3：Integrations 与 Settings

范围：

- Integration 分开显示 configured、credential presence、connectivity、scope、read/write
  capability 与 last observation。
- Settings 按 General、Runner & Safety、Server、Integrations & Workflow、Advanced 分组。
- 字段显示 source、scope、restart impact；Secret 只显示 presence。
- save 使用 preview/apply；高风险 change 显示安全影响和明确确认。

验收：

- 页面无 Token 输入、复制或回显。
- 普通 save 零 Provider 网络、零外部写。
- conflict、invalid、restart required 与 save success 有完整反馈。
- Setup 与 Operational Settings 对相同字段使用同一 schema metadata。

### Slice 4.4：Bilingual presentation QA

范围：

- 迁移剩余 HTML、JavaScript、ARIA、empty/error/loading 与 validation 文案。
- locale switch 写 User scope 并立即刷新，不改变 runtime revision。
- `<html lang>`、title、live region、日期和数字随 locale 更新。
- WorkItem、Provider title、Acceptance reason 与其他用户数据保持原文。

验收：

- English 与简体中文都能完成 Setup、status scan、run、cancel、review 和 Settings 保存。
- 两种语言下无裁切、无横向溢出、桌面 CTA 不换行。
- 页面不出现无意的中英文混排；缺失 key 只允许 English fallback。
- 切换语言的业务 journal 写入次数、Provider 网络次数和 runtime restart 次数均为零。
- 键盘、screen reader name、live region 与 validation 在两种语言下可理解。

### Slice 4.5：视觉 QA 与可访问性

检查：

- 与选定 visual target 在相同 viewport 并排比较并修正可见差异。
- 键盘导航、focus-visible、label、live region、dialog/disclosure semantics。
- WCAG AA 对比度；按钮和表单状态逐项检查。
- loading、empty、error、disabled、stale、conflict 与 reduced motion。
- 浏览器 console 零未处理错误。
- 桌面、窄屏和至少一个高密度真实 fixture 截图。

门禁：前端单元测试、server tests、浏览器 QA、独立 review-diff。

## Phase 5：Packaging 与 onboarding

### Slice 5.1：preview package

范围：

- 移除 preview 发布所需的 `private` 阻挡并确定 semver/pre-release policy。
- 验证 global install、project-local install 与 `npx` 路径。
- 评估并扩大到可支持的 Node LTS 范围，不以文档掩盖真实兼容问题。
- 更新 README 为 install、run、configure、status 的 common path。

测试：

- 干净临时目录 package install smoke。
- 无全局源码路径依赖。
- tarball 内容不含 Secret、本机绝对路径或开发状态文件。
- tarball 同时包含 `en` 与 `zh-CN` catalog。
- Windows、macOS/Linux CI 至少覆盖支持矩阵中的最低版本。

### Slice 5.2：迁移与弃用

范围：

- 默认帮助隐藏 advanced commands，但保持可调用。
- 对计划弃用命令输出一次性迁移提示。
- 一个完整发布周期后，依据真实使用证据决定是否删除 alias。
- schema v2、keychain、SSE、daemon 与 remote context 均需要新的规格和 ADR。

## 全局 verification

每个 Phase 完成前执行：

```text
npm run typecheck
npm run build
相关定向测试
npm test
package install smoke
```

涉及 UI 的 Phase 额外执行浏览器 QA；涉及配置写的 Phase 额外执行 crash、CAS、redaction
和故障注入；涉及 Provider probe 的 Phase 额外证明外部写次数为零；涉及 presentation 的
Phase 必须证明 catalog parity、双语 CLI/Web 和 locale-independent machine contract。

## 全局 review-diff 问题

1. 是否修改了目标之外的 Domain、journal 或 SDK contract？
2. 是否出现第二套配置、Readiness 或状态投影规则？
3. 是否有 user/local/command 路径能放宽项目治理或 workspace-write？
4. 是否有 Secret、Provider raw body 或本机绝对路径进入持久数据和响应？
5. 是否把 Attempt completed、AcceptanceDecision 与 Provider sync 混为一个状态？
6. 是否引入没有第二个真实 Adapter 的假 Seam？
7. 是否新增生产依赖，且没有说明验证收益与替代方案？
8. 是否具备可逆 migration、兼容窗口和诚实验证证据？
9. 是否把翻译后的 label、message 或日期写进 machine JSON、Domain 或 journal？
10. 是否存在只翻译可见文本而遗漏 ARIA、live region、validation 或 empty/error 状态？

## 暂缓事项

以下事项只有出现第二个真实部署或 Adapter 需求后才重新评估：

- OS keychain 或 Secret Vault。
- SSE/WebSocket live delta。
- 后台 daemon 与自启动。
- 第二个生产 Runner。
- 远程 Control Plane、认证、RBAC 与多租户。
- 数据库、队列、分布式锁与多 writer。
- 桌面客户端、原生安装器与自动更新。
