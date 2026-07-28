# 审查 0022：GitHub 交付证据对账

## 范围

本次审查覆盖 Linear `NP-6` / T18：

- repository-owned DeliveryMapping 与安全索引读取；
- mapped PR、Check Run、Review 的只读实时采集；
- ProviderSnapshot、ImportPlan、apply-time provenance 与原子 journal batch；
- CLI/runtime 的 preview、apply、missing Evidence 与 receipt replay；
- selector identity、revision race、幂等和持久化回退边界。

## 独立审查结论

首轮架构与后端审查发现并关闭：

1. 同一 PR head 的非语义 metadata 更新可能与既有 Artifact 冲突或重复 Evidence；
2. Review provenance 并发读取 review/PR，不能保证 PR 是最后一道 head fence；
3. Check provenance 只绑定 ID/head/time/outcome，未证明对象仍满足配置的 name/app selector；
4. Review/Check URL 未完全绑定 mapping 中的 PR number；
5. binding digest 排序依赖宿主 locale；
6. committed receipt retry 在配置、凭证和网络检查之后执行，且未绑定当前 mapping 与 active head；
7. 在 PolicyBinding v1 中直接扩展 Review object type 会破坏旧 reader 的 journal 语义；
8. Artifact 与 Check claim 并行验真时，PR 可能发生 `H → H2 → H`，只比较 Check final head SHA 会漏掉 `updated_at` ABA。

修复后复审确认：

- Delivery snapshot 把每项配置 selector 与 provider object key 一同持久化，Check fact 还保存远端实际 `name + appId` 和采集时的 PR revision time；
- Check source revision 对 `completed_at + name + appId + pull_request.updated_at` 做复合摘要，provenance 回读 exact Check、复核 selector，并用 final mapped PR 的 URL、revision time 与 head 重算摘要；
- Review provenance 按 exact review → PR final fence 顺序读取，并绑定 reviewer、state、commit、URL 和 PR head；
- 跨 claim 的 `H → H2 → H` 因 PR revision time 改变而失败关闭；同 head 的普通 metadata drift 则以本次实时采集 revision 生成新 Evidence plan，不错误依赖旧 Artifact `linkedAt`；
- PR/Review URL、Artifact、Evidence 与 mapping PR number 精确关联；
- index、criteria 与 receipt mapping 统一使用 locale-independent code-unit 排序；
- receipt retry 在 GitHub 开关、凭证和网络之前，以当前 index、active Artifact、Evidence selector、actions 与 event IDs 离线重建；旧 head 或 mapping 漂移固定 stale；
- Review batch 使用显式 PolicyBinding v3；v1 拒绝 Review，v3 必须包含 Review。第一条 v3 batch 是已记录的单向 reader fence。

最终架构与后端复审未发现剩余可执行缺陷。

## 验证证据

- `git diff --check` 通过，仅有工作树 LF/CRLF 提示。
- `npm run typecheck` 通过，无 TypeScript 诊断。
- 独立全量验证：`747/747` 测试通过，0 失败、0 跳过。
- NP-6 定向验证：`49/49` 测试通过，覆盖 delivery facts/index/read/coordinator/CLI/runtime、Review provenance 与 ImportPolicy。
- 回归明确证明：先提交 head H、再提交 H2 后，H digest 离线重试为 stale，H2 digest 离线重试为 idempotent；两者均为 0 GitHub fetch 且 journal byte-identical。
- 受控并行回归先稳定复现 Artifact claim 读到 T1、Check final fence 读到同 head 的 T2；修复后 Check claim 返回 mismatch。另一回归证明旧 Artifact 为 T1、实时同-head PR 为 T2 的 Evidence-only plan仍可按 T2 验真。
- 独立扫描确认项目不含开发者机器绝对路径或明显凭证；未新增生产依赖。

## 已知限制

- mapping index 需要受控维护，不按标题、最近分支或返回顺序自动发现 PR。
- Review 首版只支持 exact numeric reviewer，不解释 CODEOWNERS、团队或任意成员策略。
- Check 首版只支持 Check Runs，不合并 Commit Status、workflow job、deployment 或 merge queue。
- 本地 journal 仍是可信 single writer；跨进程一致性不在本切片范围。
- 首条 PolicyBinding v3 batch 落盘后，功能开关只能停止网络读取；不能安全回退到不认识 v3 的旧二进制。

## 结论

NP-6 满足 T18 合同，可以进入 PR 与 CI 门禁。Linear WorkItem、当前 Attempt、mapped PR head 与多项 Check/Review Evidence 已形成确定、可复核、可离线恢复且无外部 mutation 的交付链。
