# 规格 0026：本地 CLI 安全默认、Readiness 与项目初始化

## 背景

TaskSeal 已具备本地 CLI、Control Room、Runner、Provider 对账与人工验收闭环，
但入口体验存在三个不一致：

1. CLI `run` 默认请求 `workspace-write`，Control Room 默认只读；
2. `doctor` 只检查基础项目名，`start` 会在更深的运行时组合中发现配置错误；
3. `init` 创建固定演示 WorkItem `TS-1`，却不生成 `config/project.json`。

这些差异使安全默认、诊断结果和初始化语义难以预测。本规格只收紧本地入口，
不改变 Domain event、Provider 写权限或远程系统合同。

## 目标

- 所有 Runner 入口默认只读；写工作区必须显式授权。
- `doctor` 与 `start` 复用同一个 Runtime Readiness Module。
- `init` 创建可运行的项目脚手架，不创建业务 WorkItem。
- `demo init` 显式创建演示 WorkItem `TS-1`。
- 未配置 Linear 时仍可启动本地 Control Room；Linear 能力明确显示为 disabled。
- 一条隔离测试覆盖 `ready → run → reconcile → accept`。
- 单个工作区同一时刻只允许一个 Control Room writer。

## 公共 Interface

### Runner 权限

```text
taskseal run <work-item-id>
taskseal run <work-item-id> --read-only
taskseal run <work-item-id> --workspace-write
```

- 未提供权限参数时固定使用 `read-only`。
- `--read-only` 保持兼容。
- `--workspace-write` 是唯一写工作区授权入口。
- 两个权限参数同时出现或重复出现时返回 usage error，Runner 调用次数为零。
- 该权限只控制 Runner workspace access；TaskSeal 仍可写本地 journal。

### Runtime Readiness

Readiness Module 只暴露一次评估：

```ts
assessRuntimeReadiness(options): RuntimeReadiness
```

结果至少包含 Node、项目配置、Codex 与按集成划分的能力状态。`doctor` 负责渲染，
`start` 只消费 `ready` 与安全诊断，不复制校验规则。

- Node 必须满足 `>=24.12.0 <25`。
- 项目配置必须符合公开 schema 的根结构和已配置集成的精确结构。
- 缺少可选 Provider 配置表示 capability disabled，不是项目错误。
- `linear.acceptance` 未启用或 Linear 未配置时，不读取 Linear 凭证、不访问网络。
- `start` 在监听端口、打开 journal 或启动 Runner 前拒绝 not-ready。

### 初始化

```text
taskseal init
taskseal demo init
```

`init`：

- 创建 `config/project.json`（仅在不存在时）；
- 创建 `.taskseal/` 状态目录；
- 不创建 WorkItem、不访问网络、不读取凭证；
- 重复执行幂等，绝不覆盖现有配置。

`demo init`：

- 先执行项目初始化；
- 幂等创建示例 WorkItem `TS-1`；
- 不作为正式 WorkItem intake。

正式 WorkItem 继续通过 `ready linear ... apply` 或 application-owned import 进入。

### 单实例 writer

`start` 在打开任何 journal 前取得工作区级 Control Room lock。第二实例失败关闭，
不监听端口、不打开 Runner、不修改既有 journal。正常关闭释放 lock；异常退出留下的
lock 不自动猜测或删除，由操作者确认后恢复。

## CLI Module 结构

CLI 顶层只负责命令选择与 composition。Readiness、初始化和 Runner command 各自形成
deep Module：调用者只学习小型 Interface，文件系统、命令执行、解析、诊断和安全
默认隐藏在 Implementation 中。不得为了移动行数创建只透传的 shallow Module。

## 整链验证

隔离测试使用临时目录和本地 Adapter：

```text
Linear ready apply
  → Managed Runner completed Attempt
  → GitHub reconciliation apply
  → human AcceptanceDecision accepted
```

测试必须断言：

- Linear/GitHub 外部写入均为零；
- WorkItem 只在当前 Attempt、Artifact 和 Required Evidence 全部成立后 accepted；
- Agent completion 本身仍不能绕过验收。

## 兼容与回退

- `--read-only`、既有 `start`、Provider、journal 和 SDK Interface 保持兼容。
- CLI 默认权限从隐式写改为只读是有意的安全收紧。
- `init` 不再创建 `TS-1`；需要旧演示行为时使用 `demo init`。
- 不修改 persisted schema；回退不需要数据迁移。

## 验收标准

1. CLI 默认 run 与 Control Room 都使用 `read-only`。
2. 显式 `--workspace-write` 可用，冲突参数在 Runner 前失败。
3. `doctor` 拒绝 Node 25 和完整配置错误。
4. `start` 使用同一 Readiness 结果，不能出现 doctor-ready/start-config-failed。
5. 无 Linear 配置的项目能启动本地 Control Room，Linear transition disabled。
6. `init` 生成配置与状态目录但没有 WorkItem；`demo init` 幂等创建 `TS-1`。
7. 第二个 Control Room writer 被稳定错误拒绝。
8. 隔离整链测试通过，现有全量测试和 package install smoke 无回归。
