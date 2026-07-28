# 实验 0029：人工验收与 Linear Done 转换

## 假设

在不引入数据库、队列、Web 框架或新的生产依赖前提下，可以把 TaskSeal 的本地人工验收决定与同一个 Linear Issue 的受控状态转换连接起来，并同时保留：

- 本地 AcceptanceDecision 的 journal-first、幂等和可审计语义；
- exact Issue、Organization、Team、Project、State 与 revision 绑定；
- prepare → approve → submit 的单次写许可；
- response lost 后只读对账，不盲目重发 mutation；
- 本地决定与 Linear 同步结果分开呈现；
- 默认关闭时零凭证读取、零网络和零外部写入。

## 反证条件

- 浏览器能够提交 actor，或复用 decision ID 改写另一项决定。
- stale review、错误 WorkItem、多个 Linear Issue 或 scope 漂移仍能转换状态。
- 本地 reject 触发 Linear mutation。
- accepted 本地决定因 Linear 失败而丢失或回滚。
- response lost、并发 submit 或 restart recovery 造成第二次 mutation。
- 推荐的 `In Progress → Done` 配置在 coordinator 中被错误拒绝。
- 旧 Provider 模型或失败刷新重新开放重复 Acceptance/Reconcile。
- 配置关闭后仍读取 Linear 凭证或发起网络请求。
- v1/v2 Create operation journal 因 v3 Transition reader 而无法重放。

## TDD 过程

1. 先以领域测试锁定 v2 acceptance payload、review revision、actor/reason、decision ID、历史记录、reject 后 retry 与 accepted immutable。
2. 先以 application tests 锁定 journal-first、并发串行、全局 decision ID 冲突与精确幂等重放。
3. 先以 operation tests 锁定 v3 `work-item.transition` plan、approval、single permit、readback、unknown 与 reconcile 状态机。
4. 先以 transport/coordinator tests 锁定 exact UUID query、仅 stateId mutation、写前双重预读、写后回读、response lost 与 restart recovery。
5. 先以 runtime/config tests 锁定 feature flag、server-owned actor、expected/target State、disabled 零凭证访问与共享 operation journal。
6. 先以 server/client tests 锁定 exact JSON、CSRF/Origin、actor injection、local/Linear truth 分离、decision correlation 与旧投影兼容。
7. 独立后端审查发现 recommended `In Progress` 的 `started` stateType 被 coordinator 当作 stale；新增红灯后把 source type 白名单与 scope resolver 对齐为 `unstarted | started`，同时保留 exact State ID、revision 与 scope。
8. 独立前端审查先后发现 actor 误归因、历史不可见、写后旧快照重开按钮、全局 Provider 故障阻塞其他 WorkItem、stale Provider response 解除 fence 与轮询清除必填错误；逐项增加纯状态回归并修复。

## 已验证行为

- AcceptanceDecision 绑定当前 Attempt、Artifact、revision、Evidence gate、actor、reason、decision ID 与 review revision。
- reject 只提交本地决定，Linear mutation 次数固定为 0；新 Attempt 清除当前决定但保留完整 acceptance history。
- accepted WorkItem 不能通过普通 retry 隐式重开。
- Transition operation 使用独立 v3 schema，并由 union reader 保留 v1/v2 Create golden contract。
- coordinator 在 exact scope、expected State ID、expected revision 和非终态 state type 全部匹配后才授予一次 mutation permit。
- `started` 与 `unstarted` 都可作为已解析的 expected source type；`completed`、`canceled` 与未知类型仍失败关闭。
- mutation 明确未派发时记录安全失败；结果不确定时进入 unknown fence，只能查询同一个 UUID 对账。
- Control Room 的 actor 由服务端启动配置注入；页面区分 Current operator 与历史 decision actor，并显示时间、原因与 decision ID。
- 写后新鲜度 fence 按 WorkItem 与 dashboard/provider source 隔离；只有 POST settle 后的新请求、且 Provider reducer 实际采纳的非回退模型才能解除。
- Provider 故障不会阻塞其他 WorkItem 的本地验收；同 review 的轮询不会清除 reason 的 `aria-invalid`。
- reason 具备可见 required 提示、`required`、`aria-required`、`aria-describedby` 与持久错误反馈。
- 默认配置保持 `linear.acceptance.enabled: false`，未执行真实 Linear mutation。

## 验证结果

- 全量测试：`790/790` 通过，0 失败、0 跳过、0 取消。
- TypeScript：`tsc --noEmit` 通过。
- 浏览器 JavaScript：`public/app.js`、`public/dashboard-state.js`、`public/provider-state.js` 均通过 `node --check`。
- tracked 与 21 个 untracked 文件的 whitespace 门禁通过。
- 独立后端与前端复审在修复后均未发现剩余可执行缺陷。
- 仓库扫描未发现开发者机器绝对路径或明显凭证。

## 结论

技术假设成立。NP-7 已形成可复核的本地人工验收与受控 Linear State transition 合同；功能默认关闭，开启时仍以 exact identity、journal authority、single permit 与 unknown reconciliation 保护外部写入。

## 已知边界

- Linear GraphQL 没有 exposed expected revision mutation 参数，因此写前 stale fence 加写后核验不是远端原子 CAS。
- 本地 actor 只代表可信 loopback Control Room 的启动身份；远程认证、RBAC 与租户隔离属于后续平台切片。
- 当前 acceptance 开关默认关闭；真实目标 Issue 的端到端 mutation smoke 必须使用专用可回滚样本，不能拿产品交付 Issue 伪造证据。
- 本地 operation journal 仍假设可信 single writer；跨进程一致性留给远程团队平台规格。
- 第一条 v3 Transition record 落盘后，只能回退到认识 v3 union reader 的版本。
