# 试点 0001：ScopeLedger 单负责人 Dogfood

## 状态

章程草案已形成，等待 accountable owner 对仓库远端与首张执行票作最终确认。

## 愿景与成功信号

本试点用一个真实软件项目验证 TaskSeal 的核心承诺：

```text
Linear WorkItem
→ Agent 分工与执行
→ GitHub Artifact / Evidence
→ 人工 AcceptanceDecision
→ Linear Done
```

真实人类参与者只有一名，即当前 TaskSeal 操作者。产品分析、架构、开发、
测试和发布准备由不同 Agent 角色承担，但这些角色不是独立用户，也不能代替
accountable owner 作出验收、发布或权限决定。

第一阶段成功必须同时满足：

1. 从 ScopeLedger 的既有 Linear Project 中选择一张依赖就绪的真实任务；
2. 保护现有未提交工作，并建立可复核的 Git 基线；
3. Agent 只在关联分支实现该任务，形成 PR 和通过的 Required Evidence；
4. TaskSeal 能展示 WorkItem、Attempt、Artifact、Evidence 和阻塞原因；
5. accountable owner 明确接受或拒绝，Agent 不得自行批准；
6. 接受后才允许把同一 Linear Issue 迁移 Done；
7. 全程没有凭证、本地绝对路径、隐藏思维链或未授权外部写入进入仓库或证据。

## 当前资产与约束

### TaskSeal

- 已具备 Linear ready-work、Codex App Server Runner、分解 DAG、GitHub
  Artifact/Evidence 对账、Control Room 人工验收和受控 Linear Done transition；
- 支持每个目标仓库使用自己的项目配置，不要求 hosted 控制面；
- 当前 Control Room 只允许 loopback，不作为远程共享服务；
- Agent completed 不等于 Done，人工验收仍是最终门禁。

### ScopeLedger

- 已是 React、NestJS、TypeScript、pnpm、PostgreSQL/pgvector 组成的真实
  monorepo；
- 已有产品上下文、Harness 规则、规格、架构、测试入口和 Linear Project；
- Linear 父任务为 `NP-15`，首批子任务为 `NP-19`～`NP-40`；
- 当前 `master` 只有初始提交，完整实现仍表现为大量未提交改动；
- 当前尚未配置 Git 远端，因此还不能形成 GitHub PR/CI 证据链；
- 完成门禁为 `pnpm verify`；数据库集成和生产依赖审计分别使用
  `pnpm test:db` 与 `pnpm audit:prod`。

### 明确不在当前范围

- 虚构 2～5 名真实用户或把 Agent 当作真实员工账号；
- 远程 Control Room、认证、RBAC、租户隔离、计费、Kubernetes 或生产部署；
- 在试点前重构 TaskSeal 为 hosted SaaS；
- 在 ScopeLedger 当前未提交基线未受保护时开始并行实现；
- 未经独立授权创建公开/私有 GitHub 仓库、发布或部署。

## 参与角色与权限

| 角色 | 承担者 | 允许行为 | 禁止行为 |
| --- | --- | --- | --- |
| Accountable Owner | 当前用户 | 选择目标、批准章程、验收、决定远端可见性和合并 | 把凭证写入 Issue 或仓库 |
| Product Analyst | Agent | 阅读 ScopeLedger 事实源，收敛范围和验收标准 | 改写 owner 目标或伪造用户需求 |
| Architect | Agent | 检查模块边界、依赖方向、迁移和回退 | 未经规格扩大公共 API 或基础设施 |
| Developer | Agent | 在关联分支做最小实现并补测试 | 直接修改 `master`、绕过检查 |
| QA / Reviewer | Agent | 执行既有门禁、审查 diff、报告失败证据 | 弱化断言或把未运行检查写成通过 |
| Release Preparer | Agent | 准备 PR、CI 和可回滚交付证据 | 自行验收、发布或部署 |
| Orchestrator | TaskSeal | 派发 Attempt、投影状态、绑定 Evidence | 把 Agent completed 自动迁移为 Done |

同一个 Agent Runtime 可以依次承担多个模拟角色，但 TaskSeal 必须保留角色、
Attempt 和交付证据的可区分记录。角色模拟验证的是流程，不证明多用户协作、
权限隔离或组织购买意愿。

## 真实业务流程

1. **领取**：从 ScopeLedger Linear Project 读取依赖已满足的 Issue，首选
   基线任务 `NP-19`，不得跳过其依赖直接执行后续 Agent 演进任务。
2. **基线保护**：审查当前未提交文件、忽略规则和敏感信息；由 owner 确认
   初始仓库可见性和远端坐标后，形成首个可复核基线提交。
3. **计划与批准**：Agent 输出边界、验收、Required Evidence 和回退；
   owner 批准后 TaskSeal 才派发。
4. **实施**：使用 `feature/np-<number>-<slug>` 或
   `fix/np-<number>-<slug>` 分支；只修改任务所需文件。
5. **验证**：至少执行目标测试和 `pnpm verify`；涉及数据库或生产依赖时
   追加相应专项门禁。
6. **交付**：推送分支、建立 PR、收集 head-bound CI Evidence 和独立审查。
7. **验收**：owner 在当前 PR revision 与 Evidence 上明确 accept/reject。
8. **同步**：只有 accepted 才迁移对应 Linear Issue Done；失败或拒绝保留
   历史并建立新 Attempt。
9. **复盘**：记录人工修复次数、阻塞原因和 TaskSeal 无法表达的步骤，决定
   继续、调整或停止。

## 数据、访问和运行边界

- 开发与 Control Room 均为 local-first，只绑定 loopback；
- GitHub 只承担代码同步、PR、Review 和 CI，不作为第二套内部任务系统；
- Linear 继续承担 ScopeLedger 内部产品任务；
- Provider 凭证只从操作者环境注入，不进入 Runner 环境、日志、Issue 或快照；
- ScopeLedger 项目文档可能进入其已配置的模型/Embedding 服务，该数据边界
  由 ScopeLedger 自己的规格和环境配置控制；
- TaskSeal 只保存交付所需的稳定身份、revision、digest 和安全诊断。

## 指标与试点周期

试点分两段：

### 首票实验

- 上限：一张 ScopeLedger Issue、一个交付分支、一个 PR；
- 成功：从领取到 owner 验收和 Linear 状态同步形成完整证据链；
- 失败：任何一步需要绕过权限、伪造 Evidence、覆盖现有工作或手工修改
  TaskSeal canonical journal。

### 连续 Dogfood

- 周期：14 天或完成 5 张垂直 Issue，以先到者为准；
- 100% 已完成 Issue 绑定唯一 PR revision 和全部 Required Evidence；
- 100% Done 具有 owner AcceptanceDecision；
- 0 次 Agent 自批、未授权 Provider 写入、凭证泄露或历史证据删除；
- 任何状态不一致在 30 分钟内能够定位到稳定 Issue、Attempt、PR 或诊断码；
- 记录每张票的人工状态修复次数，目标是不超过一次且不能修改 canonical
  历史来“修绿”。

这些指标只验证单负责人交付控制，不推断多用户留存、RBAC 正确性、远程可用性
或商业转化。

## 候选路径与取舍

| 路径 | 最小价值 | 主要风险 | 结论 |
| --- | --- | --- | --- |
| A. 单负责人 local-first Dogfood | 用真实项目验证完整交付闭环 | 需要先保护未提交基线并建立远端 | 推荐 |
| B. 模拟 2～5 名用户并提前建设远程平台 | 可演示组织界面 | 产生虚假用户证据并提前扩大安全面 | 拒绝 |
| C. 等待真实团队后再开始 | 多用户证据更强 | 无法验证当前核心流程，反馈过晚 | 作为后续扩展保留 |

## 第一阶段实验卡

### 要支持的决策

判断 TaskSeal 是否已经足以控制一个外部真实仓库的单负责人交付，还是仍缺少
必须先补的多项目配置、基线接管或 Evidence 接线能力。

### 可证伪假设

在不建设远程平台、不伪造用户、也不修改 ScopeLedger 产品边界的情况下，
TaskSeal 可以把 `NP-19` 从受控执行推进到有 GitHub Evidence 的人工验收。

### 成功门槛

- ScopeLedger 现有工作被完整保留并形成 owner 确认的基线；
- TaskSeal 在 ScopeLedger 仓库上下文解析其 Linear Project 和 GitHub
  repository；
- 一次真实 Attempt 生成当前 revision 的 Artifact 和 Required Evidence；
- owner 的接受/拒绝与 Linear 状态保持双事实且可复核。

### 失败门槛

- 无法在不覆盖现有工作时建立基线；
- 必须把本地绝对路径或凭证写入版本配置；
- TaskSeal 只能绑定自身 Project，无法在 ScopeLedger 仓库独立配置；
- PR/CI revision 无法与 Attempt、WorkItem 和 Evidence 精确关联；
- 必须由 Agent 代替 owner 才能完成流程。

### 成本上限

只允许一张任务、一个仓库基线、一个分支和一个 PR；不新增认证、数据库、
队列、远程部署或多租户基础设施。

### 结果出口

- **继续**：首票通过，进入 14 天/5 票连续 Dogfood；
- **换路**：发现明确的 TaskSeal 产品缺口，先回 TaskSeal 建立独立 Linear
  修复票，验证后重试同一首票；
- **停止**：无法安全保护 ScopeLedger 当前工作，或 owner 不批准远端与数据
  边界，保持两个项目现状不变。

## Go / No-Go 与回退

进入首票实施前必须由 owner 明确：

1. ScopeLedger GitHub 仓库坐标；
2. 仓库是 public 还是 private；
3. 当前未提交实现是否作为首个基线整体提交；
4. 首票是否使用 `NP-19`；
5. 本章程是否接受。

在上述决定前：

- `NP-14` 保持 In Progress；
- `NP-12` 保持 Backlog，不启动认证、RBAC、租户、数据库/队列或远程部署；
- ScopeLedger `NP-15` 和 `NP-19`～`NP-40` 保持 Backlog；
- 不修改 ScopeLedger 工作树，不创建远端，不推送代码。

回退时关闭 TaskSeal 对 ScopeLedger 的 Provider 开关，停止本地 Control Room，
继续使用原有 Linear 与 Git 工作流；已产生的审计历史只读保留，不删除或改写。
