# 里程碑 0003：真实样本、导入与受控同步

这些 tickets 是 T05/T06 之后的建议执行顺序，不会自动同步到 Linear，也不会授权任何外部写入。

## T07.1 — 确认 GitHub 与 Linear 真实 scope

- 状态：已完成；操作者确认并完成真实 Linear 只读验证。
- 目的：消除项目配置、凭证可见范围与实际业务目标之间的歧义。
- 范围：确认 GitHub repository；确认 Linear 的真实层级为 Workspace `netpilot-z`、Team `netpilot (NP)`、Project `TaskSeal`。
- 不包含：创建 workspace/team、修改外部权限或写入 Issue。
- 依赖：T05.3。
- 验收标准：`config/project.json` 中每个坐标都有操作者确认的真实对象，Linear 只读 scope 校验通过。
- 验证：`inspect linear --issue NP-1` 成功生成 `work_item.created` snapshot；输出无凭证且 journal 哈希不变。
- 风险与回退：名称不是长期外键；本次 snapshot 已返回 Organization/Team UUID，持久化映射留到 T08。

## T07.2 — 选择一个真实 GitHub 交付样本

- 状态：已完成；真实样本为 Issue `#1`、Draft PR `#2`、PR head 上唯一完成且成功的 `tests` Check，映射为 `TS-1` / `github-live-2` / `tests`。
- 目的：为 GitHub Issue/PR/Check 链提供一个近期且可公开只读验证的真实对象。
- 范围：确定 Issue 编号、PR 编号、Check 名称、对应 WorkItem/Attempt 和 criterion。
- 不包含：TaskSeal 自动创建 PR、Push、触发 CI、评论、关闭或 merge；本次 Issue `#1` 创建是单次、明确授权的联调动作。
- 依赖：T05.1、操作者提供已有样本或单独授权外部写入。
- 验收标准：指定 PR 的 `head.sha` 上存在唯一同名 completed Check；Issue 与 PR 的业务关联由操作者确认。
- 验证：`inspect github --issue 1 --pr 2 --check tests --work-item TS-1 --attempt github-live-2 --criterion tests` 成功输出三个 canonical events；与 completed Attempt 在内存重放后为 `reviewing`、Evidence passed、AcceptanceDecision null，journal 哈希不变。
- 风险与回退：如果目标仓库继续为空，可切换到操作者指定的另一个测试仓库，但不得模糊搜索或擅自创建对象。

## T07.3 — 完成真实 provider 成功 smoke

- 状态：已完成；Linear 与 GitHub 完整成功 smoke、脱敏输出、内存重放和 journal 不变检查均已完成。
- 目的：把 T05 从“适配器通过、外部样本阻塞”升级为真实成功样本验证完成。
- 范围：分别运行一次 GitHub 与 Linear read-only inspect，保存脱敏的实验结论，不保存 raw payload。
- 不包含：journal import、缓存、轮询、Webhook 或外部写回。
- 依赖：T07.1、T07.2。
- 验收标准：两个 snapshot 都可归一；GitHub snapshot 与一个已有 Attempt 在内存中重放；结果不含 Token 和绝对路径。
- 验证：真实只读命令、文件变更前后比较、定向测试与实验记录。
- 风险与回退：provider schema 或权限失败时保留明确诊断，不降级为 fixture 成功。

## T08 — 设计并实现 snapshot import

- 状态：已完成；GitHub Issue `#3`（契约与 ADR）、`#4`（preview）和 `#5`（atomic apply/replay）均已实现并验证。
- 目的：把经过操作者确认的 provider snapshot 安全导入 TaskSeal journal。
- 范围：`external_link.linked` 或等价模型、provider object mapping、WorkItem update 语义、event revision、preview/apply 两阶段、本地审计和冲突恢复。
- 不包含：外部系统写回、多租户、Webhook 自动消费。
- 依赖：T07.3、领域 ADR、独立安全审查。
- 验收标准：同一 snapshot 重复导入幂等；provider 编辑不会触发 `WORK_ITEM_ALREADY_EXISTS` 或同 ID 不同内容冲突；一个 WorkItem 可关联 Linear 与 GitHub。
- 验证：TDD 覆盖首次 import、重复、update、冲突、乱序、journal 失败、真实子进程在 replace 前后退出和重启重放；完整门禁见实验 0005。
- 风险与回退：必须保留 preview-only 模式；import 失败不得留下部分 journal 状态。
- 契约：`docs/specs/0004-snapshot-import.md`；决策：`docs/adr/0001-snapshot-import-contract.md`；审查：`docs/reviews/0001-snapshot-import-contract.md`。

## T09 — 实现受控 Linear Issue 创建

- 状态：T08 已满足；仍等待新的明确外部写授权。
- 目的：把已审查 dry-run 草案按最小权限同步到正确 Linear team。
- 范围：独立 `work-item.write` 能力开关、Organization/Team UUID、持久 client UUID v4、operation key、payload digest、逐条审批、审计和查询对账。
- 不包含：自动关闭、批量状态迁移、评论、双向实时同步或无人值守写入。
- 依赖：T08、Linear write 凭证、操作者确认草案与写入范围。
- 验收标准：相同 operation key/payload 只产生一个 Issue；响应丢失可按 UUID 对账；payload 冲突失败关闭；拒绝审批时零外部写入。
- 验证：fake GraphQL mutation contract、幂等与失败恢复测试；真实写入先限制为一个经批准的测试 Issue。
- 风险与回退：Linear 没有文档化的原生 create idempotency；客户端 journal 与读后对账不可省略。

## T10 — 在 Control Room 展示 Provider 与同步状态

- 状态：待执行。
- 目的：让操作者从总览看到 scope 健康、snapshot 时间、映射、缺失证据、dry-run 数量和待审批写操作。
- 范围：只读投影、诊断卡片、事件时间线、审批前摘要；默认不在浏览器展示原始 Token 或 raw payload。
- 不包含：公网部署、多租户 RBAC、完整日志终端和批量无人审批。
- 依赖：T08；写操作面板依赖 T09。
- 验收标准：Control Room 能区分 `configured`、`scope mismatch`、`sample missing`、`snapshot ready`、`approval required` 和 `sync failed`。
- 验证：投影测试、HTTP 集成测试、桌面与移动浏览器走查、控制台检查。
- 风险与回退：UI 只能投影 application 状态，不能直接调用 provider 或绕过审批服务。

## T11.1 — 用契约探针选择第二个 Provider

- 状态：已完成；GitHub Issue `#9`，ADR 0003 选择 Gitee。
- 目的：用最小官方契约和公开只读探针对 Gitee 与飞书做可证伪比较。
- 范围：认证、scope、分页、错误、WorkItem 语义、公开样本和停止条件。
- 不包含：生产 adapter、凭证、外部写入、通用插件市场或远程代码执行。
- 依赖：ProviderSnapshot v2 与原子 import 边界。
- 验收标准：选定 Provider，明确 read/health contract、样本、权限和停止条件。
- 验证：Gitee 官方 schema `5.4.92`、匿名 repository/Issue HTTP 200 探针、飞书官方 token/record/error 契约和 ADR 审查。

## T11.2 — 接入 Gitee 并提取内置插件契约

- 状态：已完成；GitHub Issue `#10`。
- 目的：实现 Gitee `provider.health`/`work-item.read`，并从第三个现有实现中提取最小 `AdapterManifest`/ports。
- 范围：Gitee config/read/normalizer/inspection、静态 `AdapterManifest`、capability 与 contract tests。
- 不包含：私有仓库 token、PR/CI、Webhook、外部写入、动态插件代码或市场。
- 依赖：T11.1。
- 验收标准：Gitee 不改变领域/import allowlist即可产生可展示的 ProviderSnapshot v2；snapshot candidate 使用 rich link 而非 legacy link；只读 manifest 没有写 port；Gitee preview/apply/自带 candidate direct append 失败关闭；GitHub/Linear 与 legacy replay 兼容。
- 验证：TDD、fake contract、公开 Issue `I4` smoke、全量回归、架构与安全审查。

## T11.3 — 用飞书多维表格压力测试插件边界

- 状态：等待 T11.2 和操作者提供专用只读应用/资源；GitHub Issue `#25`。
- 目的：用 token 生命周期、app/table/record scope、POST-read、业务 error code 和动态字段反证 `AdapterManifest v1`。
- 范围：固定资源、显式字段 mapping、`provider.health`/`work-item.read` 和裁剪 snapshot。
- 不包含：创建/更新记录、动态 schema 引擎、远程插件代码或生产租户。
- 依赖：T11.2；真实 probe 需要新的飞书只读凭证与资源授权。
- 验收标准：不修改领域不变量即可读取固定 record；凭证和 raw 动态字段不进入 snapshot。
- 验证：fake contract、单记录真实只读 smoke、业务错误与字段脱敏、兼容性审查。

## T11.4 — 建立 Provider ingress gate 与 per-scope import 授权

- 状态：等待 T11.2；GitHub Issue `#34`。
- 目的：在开放 Gitee/第三方 import 前，关闭 direct append 绕过，并把全局 apply 开关收敛为 per-provider/per-scope 授权。
- 范围：可信 Adapter registry gate、rich ExternalLink journal ingress、per-scope policy、撤销与 stale binding。
- 不包含：Provider API read、外部写回、动态代码加载、插件市场或默认开启 apply。
- 依赖：T11.2 的 `AdapterManifest v1`；Gitee read 不依赖本票。
- 验收标准：新增 Provider 不能仅靠 canonical event 或 allowed scope 获得 rich link/apply；未知/撤销/stale 全部零写入。
- 验证：direct append 绕过回归、policy 矩阵、并发/重启/legacy 全量回归和安全审查。
