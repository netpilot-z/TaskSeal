# 审查 0023：人工验收与 Linear Done 转换

## 范围

本次审查覆盖 Linear `NP-7` / T19：

- AcceptanceDecision v2 与 review revision；
- Transition Operation v3、journal union 与安全投影；
- Linear exact read、state update、readback、unknown/reconcile；
- 配置、scope resolver、凭证与 runner 环境隔离；
- Control Room 写接口、Human Gate、历史审计与写后新鲜度；
- v1/v2 Create compatibility、默认关闭与文档边界。

## 独立审查结论

首轮后端审查发现：

1. scope resolver 正确接受 `In Progress` 的 `started` stateType，但 coordinator 硬编码只接受 `unstarted`，导致推荐配置在本地 acceptance 已提交后固定失败。

首轮及复轮前端审查发现：

1. 页面把当前启动 actor 显示成历史决定 actor，且未呈现 acceptance history；
2. POST 成功后的 silent refresh 失败会用旧快照重新开放 Acceptance/Reconcile；
3. reason 没有程序化 required 与持久错误说明；
4. Provider fence 是全局的，可能让单个 Provider 故障阻塞所有 WorkItem 的本地验收；
5. Provider response 在 reducer 判定回退前就解除 fence；
6. dashboard 轮询会在用户未输入时自动清除 `aria-invalid`。

## 修复与复审

- source precondition 继续精确绑定 Issue、Organization、Team、Project、expected State ID 与 expected revision，仅把允许的非终态类型与 resolver 对齐为 `unstarted | started`。
- 新增 started source 的 prepare、submit 双预读与单 mutation 回归；后端复审确认没有放宽 completed/canceled/unknown 或任何 identity/revision 边界。
- Human Gate 明确标记 Current operator，另行呈现 current decision 与完整 history；所有 actor、reason、time 和 decision ID 均经转义。
- 新鲜度 fence 改为 WorkItem + source 作用域，并在 POST settle 后建立请求阈值；dashboard fence 只控制本地决定，provider fence 只控制 Linear 对账。
- Provider 只有在 non-regressing reducer 实际采用 incoming model 并进入 `ready/empty` 后才解除 fence；stale/回退/失败模型保持锁定。
- 明确非 2xx 不再等待无意义的 Provider truth；网络结果不确定时继续保守等待。
- reason 增加 required/ARIA contract；错误只在用户输入、切换 WorkItem 或 review revision 改变时清除。
- 修复后后端与前端独立复审均未发现新的可执行问题。

## 验证证据

- 独立全量验证：`790/790` 测试通过，0 失败、0 跳过、0 取消。
- `npm run typecheck` 通过，无 TypeScript 诊断。
- `node --check` 对三个浏览器脚本全部通过。
- `git diff --check` 通过；21 个 untracked 文件的等价 whitespace 检查同样通过。
- 定向状态、Provider、HTTP 与 coordinator 回归：`55/55` 通过。
- 默认关闭的本地 Control Room 浏览器检查已验证桌面与移动断点无横向溢出、Human Gate 禁用边界正确、只读 Refresh 正常且 console 无 warning/error。
- 项目扫描未发现开发者机器绝对路径、GitHub token 或 Linear token。
- 未执行真实 Linear mutation；这与默认关闭和不得伪造产品交付证据的边界一致。

## 风险与限制

- Linear mutation 不具备服务端 CAS；若写前检查与 mutation 之间发生竞态，只能依靠写后 readback 暴露 unknown/ambiguous，而不能宣称原子条件写。
- server-owned actor 还不是远程用户身份；多人访问前必须增加认证、RBAC、租户和审计边界。
- Provider read model 故障时，本地决定仍可按 WorkItem 独立使用，但对应 Linear reconcile 会保持保守禁用。
- v3 operation journal 是单向 reader compatibility fence。
- 当前浏览器检查使用默认关闭配置，只验证 UI 与零外部写入边界，不代表真实 Linear 生产联调。

## 结论

NP-7 满足 T19 技术验证合同，可以进入 PR 与 CI 门禁。TaskSeal 已能把人工验收、受控 Linear transition、结果不确定对账和可视化审计放在同一条证据链中，同时保持默认关闭、最小权限和旧 journal 兼容。
