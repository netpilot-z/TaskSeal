# 实验 0028：GitHub 交付证据对账

## 假设

不修改 canonical Domain schema，只增加安全的 repository-owned mapping index、GitHub read 扩展和 application reconciliation coordinator，就能把 Linear WorkItem 当前 Attempt 与一个 PR head、多项 Check/Review Evidence 自动连接，并保留幂等、竞态防护和 apply-time provenance。

## 反证条件

- 根据标题、最近分支或返回顺序猜测 PR/Evidence。
- PR head 已变化但旧 Evidence 仍能满足当前验收。
- 采集 checks/reviews 期间 head 漂移仍生成可 apply plan。
- missing/pending check 被记录成 failed，或旧 commit review 被当作当前证据。
- 相同事实重复写 journal。
- index target、Linear UUID、WorkItem ownership 或 criteria 漂移后仍发起 GitHub 请求。
- apply 不重新读远端，或 exact check/review provenance 不校验当前 PR head。
- reconciliation 产生 GitHub/Linear mutation。

## TDD 过程

1. mapping config/index 测试先因 delivery schema 与 reader 不存在失败。
2. PR head checks/reviews 的 mocked-real tests 先锁定 exact selector、分页、同名歧义、旧 revision 和响应边界。
3. Review fact、multi-evidence snapshot 与 provenance tests 先因 object type/mapping/claim 不支持失败。
4. coordinator tests 先因模块不存在失败，随后逐项实现 Linear ownership、active Attempt、Artifact-first missing gate、head fence、up-to-date 和 stale apply。
5. CLI/runtime tests 先得到 usage/module 失败，再接入 disabled 零网络、target binding、真实 read-only request sequence、provenance 与 atomic batch。
6. 增加 check provenance 回归，证明 exact Check Run 即使未变化，只要 mapped PR current head 已漂移也必须 mismatch。
7. 增加 selector tamper 回归，先证明只绑定 opaque digest/object ID 不足，再把配置 selector 和实际 Check/Review identity 纳入 snapshot mapping 与 fact。
8. 增加 response-loss receipt 回归，先提交 head H、再提交 H2；旧 digest 必须离线 stale，当前 digest 必须离线 idempotent。
9. 将 Review batch 从扩展 v1 union 改为显式 PolicyBinding v3，并锁定 v1 拒绝 Review、v3 必须包含 Review 的 reader fence。
10. 用 deferred Check response 稳定制造跨 claim 的 PR `H → H2 → H` ABA；红灯证明只比 head 会误判 verified。初版把旧 Artifact linkedAt 当作 fence，又由第二个红灯证明它会误拒同-head metadata drift；最终把实时 `pull_request.updated_at` 纳入 Check fact 与复合 source revision。

## 已验证行为

- index 具备 512 KiB、路径逃逸、symlink/TOCTOU、唯一映射和最多七项 Evidence 限制。
- mapped PR 精确核对 target PR number、fork head repository 和 branch。
- Check selector按 name + 可选 app ID精确解析；missing/incomplete 不生成伪 Evidence。
- Review 按 exact reviewer、current commit、decisive state、submitted time 与 numeric ID确定性选择。
- Snapshot mapping 明文绑定每项经过审阅的 selector，Check fact 保存实际 name/appId；二者不匹配时 snapshot 在生成计划前失败。
- PR + Check + Review 在同一 ImportPlan 中生成一个 Artifact 与两项 Evidence。
- 新 head 在 Evidence 未齐时仍生成 Artifact-only plan；旧 head facts 不再作用于当前 gate。
- 采集末尾 PR 任一 fence 字段变化均返回 revision race，apply 调用次数为零。
- 同一 facts 已表示后 preview 为 `up_to_date`。
- runtime preview 不改变 journal；apply 重新采集、精确回读 PR/check/review provenance、原子提交一次，再次 preview 为 `up_to_date`。Review 的 exact object 在 PR final fence 之前读取，Check provenance 复核 name/app identity。
- committed receipt 先绑定当前 index 与 active head 再离线恢复；H→H2 后旧 digest stale、当前 digest idempotent，两者均零 GitHub 请求。
- Check final PR fence 以 mapped URL、实时 PR revision time 与 head 重算复合 source revision；并行 ABA 返回 mismatch，同-head metadata drift 的 Evidence-only plan 保持 verified。
- disabled、foreign target、missing binding 和 Linear ownership mismatch 均在 GitHub read 前失败。
- CLI 参数严格、错误脱敏，结果固定声明 `githubWrites: 0`、`linearWrites: 0`。
- Review import 使用 PolicyBinding v3；首条 v3 journal record 落盘后只能回退到认识 v3 的 union reader。

## 结论

技术假设成立。T18 可以在现有 TypeScript 单仓、Node.js 内置能力和 Snapshot Import 合同内完成，不需要 NestJS、数据库、队列或生产依赖。下一阶段 T19 可以把本地 AcceptanceDecision 与受控 Linear Done transition 连接，但不能把本次只读 reconciliation 扩权为外部写入。

## 已知边界

- 当前 mapping index 为空 bootstrap；条目需要在 PR、reviewer 与 check selector明确后受控提交。
- decisive review 若在相同 PR revision timestamp 下反向变化，Domain 会以 evidence order ambiguous 失败关闭，需要新的远端顺序事实后才能放宽。
- 首版不读取 CODEOWNERS、branch protection required-check policy、commit statuses 或 merge queue。
- 本地 journal 仍假设可信 single writer；跨进程协调留给后续存储决策。
- v3 reader fence 是有意的持久化边界；功能开关能停止网络读取，但不能让不认识 v3 的旧二进制重放已有 journal。
