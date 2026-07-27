# 审查 0019：Provider fact provenance 与对象级 locator 绑定

## 状态

通过。对应 GitHub Issue `#48`；初审与攻击复审发现的最新历史替换、remote no-event、GitHub Check 枚举、事件内容/时间/嵌套 locator 脱钩和无界写队列问题均已修复，最终独立复审未发现剩余 P0–P3。

## 独立审查范围

1. Claim 的所有权、短生命周期、digest/result 全集绑定与固定错误分类；
2. TaskSealService 的 registry、policy、conflict、base stale、Domain projection、verifier、atomic commit 顺序；
3. GitHub Issue/PR/Check 与 Linear Issue 的稳定 ID、locator、scope、revision、content binding 与 digest 对账；
4. no-event、idempotent receipt、历史 replay、Gitee 离线路径和零写入语义；
5. claim 数、并发、单请求 timeout 与 verifier-wide deadline；
6. 凭证、raw response、cause、持久化 schema 与生产依赖边界。

## 初审问题与修复

### PR/Check 验证了最新历史而非本次事件

旧 collector 从 projection 后 Workflow 选择同 ID 的最新 Artifact/Evidence。若 base 已含更新的 PR/Check，本次计划可以提交较旧事件，却让 verifier 对账更新事实。现以 action 的唯一 `eventId` 读取精确 plan event，source revision 固定使用 action binding；不同 claim 按 claim digest 去重，不再按 source key 覆盖。

### Plan v1 no-event 缺少完整证明材料

Remote `skip` 只有 source key/revision，没有 incoming URL/content。旧实现用当前 Workflow 填充 claim，使伪造 revision 可被重算 digest 后提交 receipt。现未提交的 GitHub/Linear no-event plan 固定 unavailable、零新增写；已提交 plan 的 receipt retry 在此门禁前短路，历史 replay 与 Gitee 不受影响。

### GitHub Check 未知枚举被当作失败证据

旧 response guard 只要求非空字符串，任意 conclusion 都会被映射为 failed。现 status/conclusion 使用 GitHub 官方 allowlist，completed 必须有合法 conclusion/completed_at，未完成状态必须两者均为 null；未知枚举与非法组合均为无效响应。

### Opaque digest 未绑定实际提交的 Issue title

旧 claim 只携带 content digest。调用方可保留远端正确 digest，却重写 event observation 与 WorkItem title，再重算公开 plan digest。现 claim 增加 tagged 最小 content binding：Issue title、PR head、Check head/outcome；connector 同时逐字段比较远端响应。真实 mocked GitHub PoC 现为 mismatch、零写入。

### Provider 证明未绑定将持久化的事件时间

旧 claim 忽略 `event.occurredAt` 与 Issue observation occurrence time。调用方可把 PR/Check 时间改到 2099，重算公开 plan digest 后仍通过真实远端 revision 验证，并污染 `linkedAt/recordedAt`、新旧排序和验收保留。现 claim 同时携带 source/event occurrence time：Issue create 分别对账 remote created/updated time，Issue link/observation、PR、Check 对账 remote updated/completed time；managed update event time 必须匹配同版本 Issue claim。七个 timestamp tamper 路径均固定 mismatch、零写入。

### Rich link 嵌套 observation URL 绕过外层 locator 验真

Domain 为 legacy baseline 兼容保留可选的 `lastObservation.url`，但 canonical create/link preview 不生成该字段。旧 collector 只验证 rich link 外层 URL，调用方可加入任意嵌套 URL、重算 plan digest，并在内置 verifier 通过后把第二 locator 写入 journal。现 provenance collector 在 create/link 中直接拒绝该字段；两条真实 mocked GitHub 回归均固定 mismatch、零写入。

### 验真可能长期占用串行写队列

最初最多 256 claim 串行读取，理论上可占用约 64 分钟；仅依赖 injected fetch 遵守 AbortSignal 也不是硬上限。现 application 与 connector 双层限制 8 claim，每批 4 并发，单请求最多 15 秒，并由独立 30 秒 verifier-wide deadline 包裹。忽略 AbortSignal 的 hung fetch/JSON 回归在 deadline 后失败关闭并释放队列。

## 复审结论

- Claim 精确绑定本次 plan event；较新同源历史不能替代较旧待提交事件。
- Issue/PR/Check source/event time、Issue title、PR head、Check head/outcome 与远端响应、revision 和 digest 同时绑定；Issue create/link 不接受未经验证的嵌套 observation URL。
- GitHub/Linear 未提交 no-event、缺少 verifier、响应不完整、远端不可用或任一字段漂移均在 journal 前失败关闭。
- Registry、preflight、policy、blocked、base stale 路径不消耗 verifier；receipt retry 与历史 replay 不访问 Provider。
- Claim/result 只存在于 apply 内存；Plan、ImportBatch、receipt、canonical event 与 reader schema 均保持 v1。
- 凭证只在 composition/connector closure，错误合同不回传 raw response、token 或底层 cause。

## 验证证据

- Provenance/GitHub/apply 定向测试：144/144 通过。
- `npm run typecheck`：通过。
- `npm test`：595/595 通过，0 fail、0 skipped、0 todo。
- 独立后端、架构与测试复审：均未发现剩余 P0–P3。
- 生产依赖：0。
- 本切片没有 UI 变更，因此未执行浏览器走查。

## 剩余风险

- Re-read 是 point-in-time proof，不是 Provider 与本地 journal 的分布式事务；读取后仍存在 TOCTOU。
- Verifier-wide deadline 会释放本地写队列，但忽略取消信号的已派发只读 Promise 可能继续在后台结束。
- Remote no-event receipt 需要 Plan v2 或可信 snapshot-bound 输入，不能从当前 Workflow 反推。
- 当前没有 CLI/HTTP apply、真实外部 mutation、动态第三方 verifier、签名 attestation 或 trusted plan store。

## 结论

#48 已建立“精确 plan event claim AND trusted read-only re-read AND full result set AND bounded deadline AND atomic local commit”的最小闭环。该能力适合当前本地技术验证；跨进程离线审批或第三方插件分发应另行设计签名/权威存储与隔离边界。
