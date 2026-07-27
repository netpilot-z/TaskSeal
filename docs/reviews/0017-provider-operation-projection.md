# 审查 0017：Provider Operation 安全投影

## 状态

通过。对应 GitHub Issue `#29`；后端、前端和架构初审发现的 P2/P3 已修复，三路复审均未发现剩余 P0–P3。

## 独立审查范围

1. Observation 与 Operation Journal 的所有权、query port、runtime composition 和非原子 snapshot 边界；
2. API v2 exact contract、component revision、整次失败、503 脱敏和只读路由；
3. Operation 十态映射、字段白名单、上限、恶意输入和公共 schema 演进；
4. 浏览器 v1/v2 parser、source-local anti-regression、operation-only、stale last-known 和 DOM 转义；
5. 桌面/移动布局、文本/形状状态、aria-live 摘要和无写入口。

## 初审问题与修复

### P2：公开 v1 合同隐式复用内部枚举

初始 projection status 与 diagnostic type 直接复用内部受控写 union；内部新增成员可能在不升级 schema 的情况下进入 API。现已改为独立、显式的 public literal unions，并用 exhaustive switch 与 `never` gate 映射。内部枚举增加成员会先触发类型失败，必须明确映射、拒绝或升级 schema。

### P2：query-only helper 暴露 Journal command

初始 `createLocalProviderOperationQuery()` 返回完整 `ProviderOperationJournal`，调用方仍可见 `compareAndAppend`。现返回冻结的 `ProviderOperationJournalQueryPort` facade，只暴露 `get/history/listLatest`；runtime 测试使用明确的 command-capable Journal fixture 建种，并断言查询对象没有写方法。

### P2：503 接受任意格式合法的错误码

初始 server 会回显任意满足大写格式的伪造 `code`。现只公开 `PROVIDER_SYNC_PROJECTION_INVALID` 与 `PROVIDER_SYNC_PROJECTION_UNAVAILABLE`；未知或 secret-looking code 固定回退为 unavailable，错误正文、cause 和附加字段不进入响应。

### P3：超限数组先枚举再拒绝

初始 512 条限制位于完整 descriptor 枚举和复制之后。现先读取并验证 Array 自有 data `length` descriptor；超过上限时不触发 `ownKeys` 或逐项复制，再对合法长度执行 dense/accessor/symbol 检查。

### P2：前端 v2 接受 null operation revision

初始 v1/v2 共用 nullable 判断，使 v2 `operationRevision: null` 被误认成已连接 Journal。现 v1 仅在兼容分支内部合成 null，v2 强制 canonical digest。

### P2：前端 Operation target 校验过宽

初始只检查 `kind: team` 与 `linear:` 前缀。现 Operation 使用与领域合同一致的 `linear:team-ref:<workspace>/<team>` validator，损坏 target 整次失败关闭。

### P2：Observation fingerprint 受 JSON 字段顺序影响

初始 fingerprint 直接 `JSON.stringify` 原始对象，字段重排会误报 stale。现从已验证字段按固定顺序重建完整规范化 Observation fingerprint，保留 source revision 与全部安全语义，同时忽略 JSON 插入顺序。

### 浏览器走查：移动端横向溢出

390px 走查发现单列 workspace grid 的 panel 可被内部长文本撑宽。为 panel 增加 `min-width: 0` 后，`scrollWidth === clientWidth`，桌面与移动端均无横向溢出。

## 复审结论

- application façade 只依赖两个 query port；server 只依赖组合 query，CLI startup 不启动 coordinator、transport 或 recovery。
- 两个 component revision 与 source-local freshness 保持独立；combined revision 不承担全局顺序或事务语义。
- 任一 source 失败整次 503；不返回 partial 200，last-known 只由浏览器显式保留。
- payload、actor、client UUID、resolved UUID、plan digest、Issue identity、raw response、错误正文与路径未进入 projection。
- 前端严格解析 v1/v2，拒绝较旧 Observation、较低 Operation version、equal-version drift、identity 消失与 v2→v1 回退。
- 十态、operation-only、可访问摘要和响应式布局完整；Provider 面板没有 approve/submit/reconcile 写按钮或请求。

## 验证证据

- Projection/runtime/HTTP/前端状态定向测试：27/27 通过。
- `npm run typecheck`：通过。
- `npm test`：472/472 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过。
- 生产依赖：0。
- 浏览器桌面/390px 移动走查：Refresh、卡片、operation 空态与 aria-live 摘要正常；无横向溢出、无 console warning/error。
- 独立后端、架构、前端复审：均无剩余 P0–P3。

## 剩余风险

- Observation 与 Operation 文件不是跨文件原子快照；响应只代表一次请求期间看到的两个独立 snapshot，依靠后续轮询收敛。
- latest projection 不是完整 Operation 审计历史，完整 version history 仍由本地 Journal 拥有。
- 浏览器只保护单次会话内的 last-known；进程重启后删除完整合法 journal suffix 仍超出当前无 hash-chain 的威胁模型。
- 当前没有真实 Linear mutation、浏览器 command、RBAC、公网部署或多进程 writer 保证。

## 结论

#29 已完成受控写状态的安全可观察性闭环，并保持所有写能力关闭。T10 Control Room Provider 状态里程碑可以收口；真实单票 Linear 写入继续由 `#7` 的新授权门禁控制。
