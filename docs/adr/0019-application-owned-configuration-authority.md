# ADR 0019：application-owned Configuration Control

## 状态

已接受。

## 背景

TaskSeal 当前从 `config/project.json`、环境变量与命令参数读取配置。项目坐标、Runner
参数、Provider capability 与 credential presence 的解析分散在 CLI、Readiness、server
composition 和 Provider-specific getter 中。新增 Settings 页面后，如果浏览器和 CLI
各自读写文件，会形成多套 precedence、校验和脱敏规则，并产生第二 writer 风险。

## 决策

1. 建立 application-owned Configuration Control Module，作为配置唯一权威。
2. External Seam 只暴露 `inspect`、`preview` 与 `apply` 三个入口。
3. 普通字段使用 command、environment、local、project、user、defaults 的明确 precedence。
4. 项目治理、安全 capability 和外部写权限不使用 last-write-wins，而使用更严格交集。
5. 项目配置继续位于 `config/project.json`；本机非敏感覆盖位于
   `.taskseal/config.local.json`；用户偏好位于平台用户配置目录。
6. 项目只保存 credential logical reference；首版 resolver 继续使用环境变量。
7. 配置写入使用 preview digest、expected revision、全量验证与原子替换。
8. Runtime 保存不可变 active configuration revision；文件变化形成 desired revision，
   process-bound runtime 变化首版要求重启；Provider 坐标按 operation revision 激活，
   不影响已开始的 operation（详见 ADR 0023）。
9. CLI、Setup 页面、Settings 页面、`doctor` 和 `start` 都调用同一 Module，不能直接
   读取或修改配置文件。
10. `ui.locale` 是 User scope 的非敏感 presentation preference，允许当前 command/session
    override，不允许 Project scope；切换无需 runtime restart。
11. CLI 通过 `ConfigurationAuthority` Interface 在 Local Adapter 与 Running-instance Adapter
    之间选择。Control Room lock 存在时必须验证 loopback endpoint 与随机 instance ID；验证
    失败固定停止，不能回退为第二个离线 writer。
12. `start` 只自动回收格式完整的 schema v2 lock，且必须由 OS PID probe 明确证明 owner
    已退出，并在删除前再次核对 lock 内容未变化。旧版、损坏、权限不明、PID 仍存活或并发
    变化的 lock 继续失败关闭。已运行实例只有在 loopback endpoint 回读同一 instance ID 后
    才视为幂等启动成功。

## Interface

```ts
inspect(context): ConfigurationView
preview(change, expectedRevision): ConfigurationPlan
apply(planDigest, expectedRevision): ConfigurationReceipt
```

调用侧使用的传输无关 Interface 为：

```ts
ConfigurationAuthority {
  inspect()
  readDraft(scope)
  applyChange(change, expectedRevision)
  applyDraft(scope, document, expectedRevision)
}
```

Local Adapter 与 Running-instance Adapter 最终都进入上述 Configuration Control 的
preview/apply Implementation；HTTP、lock discovery、instance identity 和 CSRF 不泄漏给调用者。

Interface 不公开 source 文件布局、merge 算法、credential value、schema migration、
atomic replace 或 Adapter-specific normalization。

## 安全规则

- workspace-write 不能配置为持久默认值。
- user、local、environment 和 command 不能扩大 project Provider scope。
- Adapter manifest 只声明 capability，不授予权限。
- config enablement 不代表外部 mutation approval。
- Secret value 不进入 argv、配置、HTTP GET、journal、日志、错误或浏览器存储。
- ConfigurationView 只显示 credential binding 的 source 与 presence。
- preview 和 apply 都不自动访问 Provider；connection probe 是独立显式只读动作。
- revision conflict、stale plan 或 field-not-overridable 固定零写入。

## 选择理由

删除 Configuration Control 后，source discovery、precedence、scope policy、redaction、
validation、CAS 与 restart impact 会重新散落到 CLI、server、Readiness 和每个页面，说明
它是提供 Leverage 与 Locality 的 deep Module，而不是文件读写透传层。

三个入口同时服务人类 CLI、自动化 JSON、Setup 与 Settings，调用者不需要了解配置
Implementation。文件系统属于 local-substitutable dependency；生产使用真实文件
Adapter，测试使用临时目录，不把 filesystem port 扩大为 external Interface。

## 被拒绝方案

### 只增加更多环境变量

环境变量适合 Secret 和 CI 临时值，但不能提供可审查项目配置、字段来源解释、CAS 或
安全 scope policy。

### 浏览器直接编辑 `config/project.json`

这会复制 schema 和安全规则，绕过 revision，并让页面成为第二 writer。

### 所有配置只放项目文件

端口、浏览器偏好和本机 Runner 路径不应进入版本控制，也不得把开发者绝对路径写入
项目文件。

### 首版引入 OS keychain 或通用 Secret Vault

当前只有 environment resolver 这一种真实实现。没有第二个真实 credential Adapter
前不提前制造通用 Seam。

### 立即迁移 TOML、YAML 或数据库

现有 JSON schema 已公开且可验证。格式迁移不能解决权威、precedence 与安全交集问题，
反而引入依赖和不可逆迁移。

## 影响

- 项目配置路径和 v1 schema 保持兼容，但内部先归一化为 ConfigurationView。
- 新增 user/local source 后，每个字段必须声明允许的 scope。
- Settings save 与 CLI config write 都必须先 preview，再 apply。
- Runtime 页面需要展示 active 与 desired revision，并明确 restart required。
- credential 状态可诊断，但页面不会提供 Secret 输入体验。
- locale change 只刷新 presentation，不进入 active/desired runtime revision，也不写业务 journal。

## 回退

新 Module 先包装现有 `readProjectConfiguration`，不修改 persisted schema。回退时可以
移除新 CLI/UI Adapter，旧配置与 journal 仍可被旧版本读取。任何未来 schema upgrade
都必须独立规格、preview 和 migration receipt。
