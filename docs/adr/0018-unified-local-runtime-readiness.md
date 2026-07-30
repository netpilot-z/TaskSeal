# ADR 0018：统一本地 Runtime Readiness 与安全入口

## 状态

已接受。

## 背景

本地 CLI 的安全权限、配置诊断和项目初始化分别散落在命令解析、`doctor`、
Control Room composition 与 Acceptance runtime 中。调用者必须知道多套隐含前置
条件，且相同项目可能通过 `doctor` 后在 `start` 中失败。

## 决策

1. 建立 application-owned Runtime Readiness Module，统一 Node、项目配置、Codex
   与 capability 诊断；`doctor` 和 `start` 共享同一 Interface。
2. Runner workspace 权限默认只读；写权限只由显式 `--workspace-write` 授予。
3. 项目初始化与演示数据分离：`init` 建立脚手架，`demo init` 创建 `TS-1`。
4. Linear 是可选 Provider；未配置或 transition disabled 时，本地 Control Room
   与人工 Acceptance 不依赖 Linear 凭证或网络。
5. 本地文件 journal 继续保持单 writer，并由 Control Room lock 在 composition
   入口失败关闭第二实例。

## 选择理由

- 一个 Readiness Interface 隐藏多处配置与进程检查，给 `doctor`、`start` 和测试
  提供共同 Leverage 与 Locality。
- 默认只读符合 Runner Host 已接受的权限模型，不再让不同入口产生相反默认值。
- 初始化不再写业务事实，避免脚手架命令偷偷创建演示 WorkItem。
- 先使用显式单实例 lock 兑现当前文件存储保证；没有第二个真实存储 Adapter 前，
  不提前引入数据库 Seam。

## 被拒绝方案

### 只扩展 README

文档不能消除入口行为差异，调用者仍可能在无意中获得 workspace write。

### 为每个命令复制配置校验

复制会再次产生漂移，且测试必须理解多个 shallow Interface。

### 立即引入 SQLite、远程数据库或分布式锁

当前仍是单机试点，尚无第二个部署或存储 Adapter。重型存储不会修复入口语义，
反而扩大迁移与运维范围。

### 自动清理未知来源的 lock

无法确认原 writer 是否仍存活时删除 lock 可能形成双 writer，因此失败关闭并要求
人工确认。

## 影响

- 未带权限参数的 CLI run 从写工作区变为只读。
- 新项目先运行 `taskseal init`；演示用户运行 `taskseal demo init`。
- `doctor` 会比旧版本更严格，能在启动前暴露真实配置问题。
- Domain、journal、Provider 和 SDK persisted contract 不变化。

## 回退

所有变化都位于本地 composition 和 CLI Interface，没有 persisted schema 迁移。
可恢复旧命令路由，但不建议恢复隐式 workspace write。
