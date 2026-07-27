# 实验 0018：Fake Linear 写入与对账 Transport

## 实验卡

- 决策：只注入 fake GraphQL exchange，能否在 journal/coordinator 之前证明 Linear create 的保守派发分类与 client UUID 查询对账。
- 假设：application-owned 可判别 port 加 connector-owned bounded runtime guard，足以让后续 coordinator 不解析异常正文、不盲重试 create。
- 反证：timeout/HTTP/schema 被误报 not-dispatched；响应丢失后无法按同 UUID found；query failure 被误报 absent；wrong Team/ID 被当成 found；raw body/错误正文进入结果；构造 transport 即产生调用。
- 指标：定向测试、全量测试、类型检查、生产依赖、diff 检查和独立后端审查。
- 边界：没有真实网络、凭证、global fetch、Operation Journal wiring、coordinator、CLI/HTTP 或真实 Linear mutation。

## Red

先新增 transport 行为测试；测试因 `linear-write-transport.ts` 不存在而以 `ERR_MODULE_NOT_FOUND` 失败。Red 已固定：

1. mutation/query document 与 variables；
2. created、not-dispatched、outcome-unknown；
3. found、absent、failed、ambiguous；
4. request/external-write counters；
5. bounded input/response 与脱敏；
6. rejected Operation 不产生隐式调用。

## Green

- 新增 application-owned `LinearWriteTransportPort`，coordinator 不需要依赖具体 connector。
- `InjectedLinearWriteTransport` 没有默认 exchange、global fetch、endpoint 调用或 credential 参数。
- create 固定把 client UUID 写入 `IssueCreateInput.id`，把 resolved Team UUID 写入 `teamId`。
- query 只使用 `issue(id: client UUID)`，不按 title、时间或第一条结果猜测。
- 只有 exact `not_dispatched` 能返回 not-dispatched；exchange throw、timeout、response lost、HTTP、GraphQL、schema 和 correlation mismatch 全部 outcome unknown。
- query 只有合法 null 是 absent；返回对象但 ID/Team/identifier 不一致是 ambiguous，其他请求/响应故障是 failed。
- request 128 KiB、response 64 KiB；response 在 JSON parse 前检查 byte limit。
- fake 的 response-lost 模式先创建 Issue 再丢弃响应，下一次 query 精确 found，external write count 保持 1。
- public result/error 深度 inspect 不包含 fake Provider 原始错误 sentinel，输入错误发生在 exchange 前且没有 `Error.cause`。

## 验证证据

- Fake Linear transport 定向测试：40/40 通过。
- `npm run typecheck`：通过。
- `npm test`：422/422 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过。
- 生产依赖：0。
- 独立后端与架构审查：均无 P0–P3；审查建议的 wrong identity、success=false、文本边界与对抗性 data-object 测试已补齐。

## 结论

实验当前支持假设。#41 已把 fake create/query 的派发与对账语义收敛成窄 port，但它本身不拥有 submitting permit，也不调用 journal。下一步 #42 必须证明只有本次持久化 `submitting` 返回 committed 才能消费一次 create call；真实 Linear mutation 仍未授权。
