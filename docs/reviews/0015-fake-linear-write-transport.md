# 审查 0015：Fake Linear 写入与对账 Transport

## 状态

通过。对应 GitHub Issue `#41`；独立后端与架构审查均未发现 P0–P3 可执行问题。

## 独立审查范围

审查覆盖：

1. create/query application port 与 connector GraphQL adapter 的依赖方向；
2. client UUID、resolved Team UUID 与 Linear identifier correlation；
3. not-dispatched、outcome unknown、found、absent、failed 与 ambiguous 分类；
4. input/exchange/GraphQL envelope exact-key、Unicode 和 byte bounds；
5. raw body、错误正文、凭证、底层异常与 `Error.cause` 泄露面；
6. fake request/external-write counters 和 response-lost reconciliation；
7. global fetch、真实 endpoint、credential、journal/coordinator 或 mutation 是否意外进入本切片。

## 审查结论

### Port 所有权与依赖方向

`LinearWriteTransportPort` 由 application 层拥有，只暴露 coordinator 所需的 client UUID、Team UUID、payload 和可判别结果。connector 单向 type-import 该 port，并独立拥有 GraphQL document、request envelope、response runtime guard 与派发不确定性分类。test-support fake 只依赖 connector exchange 合同，不进入 production application。

该结构允许 #42 只依赖 journal ports、transport port 与 clock；composition root 再注入 fake。未来真实 Linear 网络 adapter 也可以在 connector 层实现 exchange，而不改变 coordinator。

当前保持 Linear-specific 是有意边界。caller-provided Issue UUID、Team correlation、identifier 与 query reconciliation 都是 Linear 语义；在没有第二个可写 Provider 证据时抽取通用 `ProviderWriteTransport` 会提前统一未知的幂等和对账语义。

### 派发与对账分类

- 只有 exact `not_dispatched` 会产生 terminal pre-dispatch 结果。
- create 侧 exchange throw、timeout、response lost、HTTP、GraphQL、schema、oversized、success=false 和 identity mismatch 全部 outcome unknown。
- query 侧只有合法 `data.issue = null` 是 absent；请求/响应故障是 failed；返回对象但 ID、Team 或 identifier correlation 不可信是 ambiguous。
- transport 不重试 create，也不解析异常正文猜测是否派发。

### Runtime 与脱敏

- input、exchange result、GraphQL envelope、payload 与 identity 均进行 runtime validation。
- request 128 KiB、response 64 KiB；response 在 JSON parse 前检查。
- Proxy trap、accessor、symbol key、non-enumerable 与附加字段都在 exchange 前失败关闭。
- public input error 固定 code/message 且无 cause；exchange error、raw body 与 GraphQL error text 只影响安全分类，不进入公开结果。
- connector 没有 global fetch、endpoint 调用、Authorization、API key/OAuth 参数或日志器。

## 审查后补强

独立后端审查认为实现已正确失败关闭，但建议把以下静态路径变为直接证据：

- create wrong ID、invalid identifier 与 `success=false`；
- description code-point / byte 精确上限；
- accessor、symbol 与 non-enumerable 输入。

现已增加回归；定向测试由 35 增至 40，全部通过。

## 验证证据

- Fake Linear transport 定向测试：40/40 通过。
- `npm run typecheck`：通过。
- `npm test`：422/422 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过。
- 生产依赖：0。
- 独立后端审查：无 P0–P3。
- 独立架构审查：无 P0–P3。

## 剩余风险

- #41 不拥有 journal version、approval 或 submitting permit；这些必须由 #42 组合证明。
- response-lost fake 只证明 correlation 流程，不证明真实 Linear 的可见性延迟、权限变化或重复 create 幂等。
- 真实网络 exchange、当前 schema probe、credential/permission、rate limit 与 endpoint 安全尚未设计，也未获授权。
- rejected Operation 的零调用只证明 transport 没有后台行为；只有 #42 能证明调用者不会把 rejected/approved/idempotent 当成 permit。

## 结论

#41 已提供一个可替换、可审查且完全离线的 Linear create/query transport 边界。可以进入 #42，把 journal committed submitting 与一次 create call 组合成可重启、可对账的 coordinator；真实 Linear mutation 仍保持关闭。
