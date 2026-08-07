# ADR 0020：受限 SetupRuntime 与 OperationalRuntime 分离

## 状态

已接受。

## 背景

规格 0026 与 ADR 0018 要求 `start` 在监听端口、打开 journal 或启动 Runner 前拒绝
not-ready。配置页面若只存在于完整 Control Room，操作者必须先手工修复配置才能打开
页面；若为了配置而让 not-ready Control Room 继续启动，又会削弱 fail-closed 保证。

## 决策

1. 建立独立 SetupRuntime composition，专门承载首次初始化、配置和 Readiness 诊断。
2. 裸 `taskseal` 在 TTY 且 core not-ready 时进入 SetupRuntime；`taskseal setup` 可显式
   进入；`taskseal start` 保持 fail-closed。
3. SetupRuntime 固定绑定 loopback，只提供静态 Setup 页面、Configuration Control 与
   Runtime Readiness 输入 Adapter。
4. SetupRuntime 不打开 canonical journal、Provider Operation Journal、Runner、
   Acceptance、Decomposition、Control Room writer lock 或外部写 Adapter。
5. provider connection test 只有用户显式触发时才构造有界只读 Adapter；普通页面
   load、show、preview、apply 和 readiness 零 Provider 网络。
6. 配置达到 ready 后，SetupRuntime 必须终止，再由标准 OperationalRuntime 从头评估、
   获取 writer lock、重放 journal 并组合 Runner/Provider；不允许同进程隐式升级。
7. SetupRuntime 与 OperationalRuntime 共用 Configuration Control 和 Runtime Readiness，
   但拥有不同 capability allowlist。

## SetupRuntime capability

允许：

```text
project scaffold read/init
configuration inspect/preview/apply
credential presence check
runtime readiness
explicit bounded read-only provider probe
browser open
```

固定拒绝：

```text
canonical journal open or append
attempt reserve/run/cancel/retry
acceptance decision
decomposition approve/dispatch/retire
provider import/apply
provider controlled write
external mutation
non-loopback listen
```

Operational route 在 SetupRuntime 中必须返回稳定 `CAPABILITY_DISABLED`，不能依赖前端
隐藏按钮实现安全。

## 选择理由

SetupRuntime 让 common-path 配置可视化，同时不让未就绪 runtime 获得业务状态或外部
能力。它与 OperationalRuntime 是两个 composition Adapter，共享 application Module，
而不是两套配置和诊断实现。

终止再启动保持初始化顺序明确：只有标准 start path 能获取 writer lock、打开 journal
和绑定 active config revision。这样 ADR 0018 的安全结论无需修改。

## 被拒绝方案

### 放宽 `start`，让 not-ready Control Room 降级运行

同一 server composition 中很难证明 Runner、Provider、Acceptance 与 journal 均未被
意外构造，也会使 doctor-ready/start-ready 语义再次漂移。

### 用本地 HTML 直接编辑配置文件

静态页面无法安全拥有 CAS、原子写、schema validation 与 credential redaction，也会
成为第二 writer。

### CLI-only wizard

终端 wizard 对自动化有帮助，但不能承担 Integration 状态、字段来源、restart impact
和后续 Settings 体验。CLI 与 Web 应共享 Module，而不是互相替代。

### 首次配置时自动测试所有 Provider

自动网络请求会读取凭证并扩大首次运行副作用。connection test 必须由用户显式触发，
且只读、有界、可诊断。

## 影响

- 新增 SetupRuntime 静态入口和受限 HTTP route allowlist。
- 裸命令需要根据 TTY、项目发现和 core Readiness 选择启动模式。
- `taskseal start`、自动化和 CI 语义保持不变。
- Setup 页面保存 runtime-affecting 配置后显示 restart required，并通过显式动作重启。
- SetupRuntime 不获取 Control Room writer lock，但配置写仍由 Configuration Control 的
  revision 与配置写锁串行化。

## 回退

SetupRuntime 不写业务 journal，也不改变 persisted Domain contract。回退时移除裸命令的
setup 分支，操作者仍可使用 `init`、`doctor` 与手工项目配置；OperationalRuntime 和现有
journal 不受影响。
