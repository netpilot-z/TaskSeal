# 实验 0022：Provider fact provenance apply-time re-read

- 日期：2026-07-28
- 关联：GitHub Issue `#48`
- 规格：[0015-provider-fact-provenance.md](../specs/0015-provider-fact-provenance.md)
- ADR：[0007-provider-fact-provenance-read-verification.md](../adr/0007-provider-fact-provenance-read-verification.md)

## 决策

先验证 apply-time read-only re-read，不实现 signed attestation 或 persistent trusted plan store。实验通过后，才把同一窄 port 接入 GitHub Issue/PR/Check 与 Linear Issue。

## 假设

在不升级现有持久化 schema、不引入生产依赖且不保存凭证/raw response 的前提下，TaskSeal 可以：

1. 从本次 action 绑定的精确 plan event 生成完整、去重、可绑定结果的 claim；
2. 让同 scope 的伪造 stable ID↔locator 即使重算全部公开 digest 也无法提交；
3. 在断网、凭证撤销或 verifier 缺失时让新 apply 失败关闭；
4. 让 committed receipt retry 和历史 batch replay 保持离线；
5. 精确识别 remote revision/content drift 并要求重新 preview。

## 最小原型

原型只允许以下新增边界：

- application-owned claim/result/port 与严格集合校验；
- TaskSealService 一个显式注入点；
- GitHub、Linear 现有 read client 的单对象只读入口；
- connector-owned verifier adapter；
- mock HTTP/GraphQL 和 in-memory journal tests。

不新增 CLI/HTTP apply route，不读取真实凭证，不发起真实 Provider mutation。

## 可证伪条件

出现任一结果即否定当前方案或停止产品化：

- verifier 未覆盖全部 claim 仍能 commit；
- 伪造同 scope ID/URL 并重算 plan digest 后仍能 commit；
- mismatch/unavailable 后 journal 有任何 batch 写入；
- receipt retry 或 `TaskSealService.open` replay 访问网络；
- 需要把 token/raw response 放入 plan、journal 或 error；
- 为完成实验必须新增生产依赖或改变历史 batch reader；
- 对 GitHub/Linear 的单对象 API 无法可靠获得 stable ID、locator、scope 与 revision/content。

## 观察指标

- verifier 调用次数与去重后的 claim 数；
- registry/policy/blocked/base-stale/receipt 路径的 verifier 调用数必须为零；
- mismatch/unavailable 的 batch commit 数必须为零；
- committed path 仍为一次 Domain projection、一次 atomic batch；
- restart/replay 的网络调用数必须为零；
- 完整回归测试数量与失败数；
- plan/batch/receipt shape 是否保持不变。

## Red 证据

- 引入 `baseWorkflow` 精确事件接口后，旧实现的 typecheck 因仍暴露 candidate `workflow` 合同而失败。
- 独立审查复现：Workflow 同 source 已有更晚 PR/Check 历史时，旧 collector 会验证更晚记录，却提交 plan 中较旧事件。
- 旧实现允许 GitHub/Linear remote no-event plan 从当前 Workflow 生成 claim；伪造 action revision 并重算公开 digest 仍可能提交 receipt。
- GitHub Check Run 旧 guard 接受任意非空 status/conclusion，可把未知 conclusion 降级成 failed evidence。
- 新增真实 mocked GitHub 回归首次运行得到 `Missing expected rejection`：只保留远端正确 content digest、但重写 plan event 的 Issue title 后，旧 claim 仍会通过并提交。
- 独立后端复审证明：只改 PR/Check `event.occurredAt` 为 2099 并重算 plan digest，旧 claim 仍对账真实 2026 revision，却会把伪造 `linkedAt/recordedAt` 写入 Domain。
- 独立后端复审证明：向 Issue create/link 的 `lastObservation.url` 加入攻击者 URL 并重算 plan digest，旧 collector 仍会用正确外层 URL通过 verifier，却把未验真的嵌套 locator 写入 journal；新增两条回归首次运行均得到 `Missing expected rejection`。
- 仅把 15 秒 AbortSignal 传给 injected fetch 不能形成可证明的总时限；忽略 signal 的 fetch/JSON 可以无限占用写队列。

## Green 证据

- `ProviderFactProvenanceClaim v1` 现在从 action 的唯一 event 生成，携带 stable identity、scope、locator、revision、digest 与最小 event content binding；不同 revision 不再按 source key 覆盖。
- Issue title update 必须复用同 source/revision/digest/source time 的 Issue claim；Issue created/updated time、PR updated time、Check completed time、Issue title、PR head、Check head/outcome 均与远端响应逐字段对账。
- Issue create/link 只接受已验真的 rich link 外层 URL；canonical preview 不会生成的 `lastObservation.url` 在 verifier 与 journal 前固定 mismatch。
- GitHub/Linear remote no-event plan 在 verifier 前 unavailable；伪造 no-event revision 为零新增 journal write。Receipt idempotent short-circuit、历史 replay 与 Gitee 保持离线。
- GitHub Check status/conclusion 使用官方 allowlist，并验证 completed/incomplete 字段组合。
- Application 与 connector 双层限制最多 8 claim；connector 每批 4 并发、单请求最多 15 秒，并由独立 30 秒总 deadline 包裹。忽略 AbortSignal 的 hung fetch 回归在短测试 deadline 内失败关闭。
- Verifier result 的 partial、duplicate、unknown、malformed、异常和敏感 cause 全部归一到固定错误；mismatch 与 unavailable 均零写入。
- 相关定向测试：144/144 通过；覆盖 Issue create/link 嵌套 observation URL、Issue create/observation/update、PR artifact 与 Check evidence 时间篡改。
- `npm run typecheck`：通过。
- `npm test`：595/595 通过，0 fail、0 skipped、0 todo。
- Plan/Batch/receipt/canonical event schema 未修改；生产依赖仍为 0。

## 结论

实验通过。Apply-time read-only re-read 能在不新增持久化 schema、生产依赖或默认外部写权限的前提下，阻止同 scope ID↔locator、revision、digest 与实际事件内容漂移。`#48` 可以在 PR 合并后关闭。

保留边界：

- 这是 point-in-time read proof，不消除 Provider read 与本地 journal commit 之间的 TOCTOU。
- 未提交的 GitHub/Linear Plan v1 no-event 不能生成 receipt；若产品需要此能力，应升级 Plan 或采用可信 snapshot-bound 输入。
- 总 deadline 释放 TaskSeal 写队列，但已经派发且忽略取消信号的只读请求可能在后台自行结束；可信 connector 必须继续遵守 AbortSignal。
- 本实验没有 CLI/HTTP apply route、真实 Provider mutation、动态第三方代码、签名 attestation 或 trusted plan store。
