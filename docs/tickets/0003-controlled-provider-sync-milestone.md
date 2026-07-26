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

- 状态：已拆分为 GitHub Issue `#3`（契约与 ADR）、`#4`（preview）和 `#5`（atomic apply）；`#3` 的本地规格与独立审查已完成，待发布。
- 目的：把经过操作者确认的 provider snapshot 安全导入 TaskSeal journal。
- 范围：`external_link.linked` 或等价模型、provider object mapping、WorkItem update 语义、event revision、preview/apply 两阶段、本地审计和冲突恢复。
- 不包含：外部系统写回、多租户、Webhook 自动消费。
- 依赖：T07.3、领域 ADR、独立安全审查。
- 验收标准：同一 snapshot 重复导入幂等；provider 编辑不会触发 `WORK_ITEM_ALREADY_EXISTS` 或同 ID 不同内容冲突；一个 WorkItem 可关联 Linear 与 GitHub。
- 验证：TDD 覆盖首次 import、重复、update、冲突、乱序、journal 失败和重启重放。
- 风险与回退：必须保留 preview-only 模式；import 失败不得留下部分 journal 状态。
- 契约：`docs/specs/0004-snapshot-import.md`；决策：`docs/adr/0001-snapshot-import-contract.md`；审查：`docs/reviews/0001-snapshot-import-contract.md`。

## T09 — 实现受控 Linear Issue 创建

- 状态：等待 T08 与新的明确外部写授权。
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

## T11 — 提取第二个 Provider 后的插件契约

- 状态：待验证。
- 目的：在 GitHub/Linear 真实闭环稳定后，为 Gitee、飞书多维表格或其他 Agent Runtime 提供可扩展接入边界。
- 范围：能力声明、read/write 权限分离、配置 schema、credential reference、health check、snapshot/dry-run/apply 契约和版本兼容。
- 不包含：先验设计完整插件市场、远程代码执行、第三方不受信任插件沙箱和计费。
- 依赖：T09 或至少两个真实 provider 的重复模式证据。
- 验收标准：第二个 provider 不修改领域不变量即可接入；只读插件不能调用写 capability；适配器 contract 有独立测试包。
- 验证：以 Gitee 或飞书中的一个最小只读适配器作为反证实验。
- 风险与回退：如果第二个 provider 没有形成稳定重复结构，继续保留窄适配器，不提前抽象通用 SDK。
