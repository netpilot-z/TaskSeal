# ADR 0011：显式 GitHub DeliveryMapping 与实时对账

## 状态

已接受。

## 背景

TaskSeal 已有 WorkItem、Attempt、Artifact、Evidence、Snapshot Import 与 GitHub apply-time provenance，但早期 GitHub inspection 仍要求操作者逐次输入 Issue、PR 和 Check 编号。T18 需要让 Linear 任务与代码交付自动关联，同时不能通过标题、最近分支或第一条 PR 猜测所有权。

## 决策

采用“仓库版本化显式映射 + 实时只读 GitHub 对账”：

- `config/project.json` 只保存 target repository、开关和 mapping index 相对路径；
- mapping index 明确绑定 Linear UUID、WorkItem、PR number、head repository/branch 与每个 Evidence selector；
- index 表达关联意图，不作为远端事实；PR、head、checks、reviews 每次 preview/apply 都从 GitHub 实时读取；
- PR head SHA 复用现有 Artifact revision，Check/Review 复用现有 Evidence canonical event；
- ProviderSnapshot 的每项 delivery Evidence binding 同时保存经过审阅的 selector；Check fact 保存实际 `name + appId` 与实时 PR revision time，短生命周期 source revision 绑定三者，不能用同 ID 的其他 Check 或同-head 旧 PR observation 冒充；
- reconciliation 通过 ProviderSnapshot v2、ImportPlan、provenance verifier 与原子 batch进入 workflow，不为 GitHub 新建旁路状态模型；
- 采集完成后再次读取 PR作为 revision fence；Review provenance 先读取 exact review，再把 PR current head 作为最后一道 fence；Check provenance 用 final PR 的 mapped URL、`updated_at` 与 head 重算复合 source revision，拒绝跨 claim 的 head ABA且不依赖旧 Artifact `linkedAt`；apply 重新采集并验证已审阅 plan digest；
- committed receipt retry 只从 index 与 journal 重建当前 mapping、active Artifact、Evidence binding 和 event identity；只有完整匹配才离线返回 idempotent，旧 head 或 mapping 漂移固定 stale；
- 含 `pull_request_review` 的 batch 使用独立 `PolicyBindingV3`。v1 reader 继续只解释旧 GitHub object type，v2 继续专属于 Gitee，避免在既有 schema 版本中静默扩展持久化 union；
- 首个接口为本地 CLI，整个组件只具备 GitHub read 和本地 journal apply，不具备外部写权限。

## 选择理由

- 显式映射可代码审查、版本回退和精确审计，不依赖易漂移命名约定。
- base repository 与 fork head identity 分离，既支持 fork PR，也避免把 head repo误当 scope。
- 复用 Domain 现有 revision-bound Evidence 规则，新 head 会自然使旧 Evidence 退出当前验收 gate。
- 复用 Snapshot Import/provenance，计划审阅、policy、远端回读、原子持久化和 idempotency 保持一套合同。
- 空 index 与 disabled 开关都能安全回退，不会隐式扫描仓库。

## 被拒绝方案

### 按 Linear/GitHub 标题或分支前缀自动发现

名称不是稳定身份，重命名、重复标题和 fork 会产生错误关联，因此不采用。

### 把 PR、check 和 review 直接 append 到 canonical journal

这会绕过 ImportPlan、scope policy、provenance 与 atomic batch，无法证明 facts 对应人工审阅计划，因此不采用。

### 先建立通用插件市场或事件总线

T18 只需证明一个 GitHub delivery adapter 的边界。动态加载、签名、沙箱、租户权限和分发属于后续 Runner/Adapter 产品化，不在本决策中提前实现。

### 缺少任一 Evidence 时完全不导入

这会让新 PR head 在 CI pending 期间继续沿用旧 head 的 Acceptance/Evidence。当前决策先导入新 Artifact，并把缺项显式投影为 missing。

## 影响

正面：

- Linear 任务、当前 Attempt、PR head 与多个 Evidence criterion 形成确定性关联。
- 重复对账不产生重复 canonical events。
- PR/check/review race 在 preview 与 apply 两层失败关闭。
- 已提交 receipt 的网络丢包重试可以在禁用集成、无凭证时离线恢复，但只承认当前 mapping 与当前 head。
- GitHub 与 Linear 外部写计数固定为零。

限制：

- mapping 需要人工或受控工具维护，首版不自动创建条目。
- Review 只支持 exact numeric reviewer；不解析团队、CODEOWNERS 或“任意一人批准”策略。
- Check 只支持 Check Runs，不合并 Commit Status、workflow job 或 deployment gate。
- 多进程共享 journal 仍受现有 single-writer 边界约束。
- 第一条 `PolicyBindingV3` batch 落盘后形成单向 reader fence；旧二进制若不认识 v3，不能安全重放该 journal。

## 回退

把 `github.delivery.enabled` 设为 `false` 即可停止新的 delivery network read；已提交 receipt 仍可在不访问 GitHub、无需凭证的情况下离线重放。mapping index 是非敏感仓库文件，可独立回退。

二进制回退边界是显式的：在首条 `PolicyBindingV3` batch 落盘前，可以删除 CLI composition 或回退实现；落盘后只能回退到具备 v1/v2/v3 union reader 的版本。若必须回到不认识 v3 的版本，需先恢复到该批次之前的 journal 备份，不能仅关闭功能开关。这是 reader-first 持久化升级边界，不承诺旧 master reader 的向后读取能力。
