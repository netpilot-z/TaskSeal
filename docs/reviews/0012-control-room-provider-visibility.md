# 审查 0012：Control Room Provider 可视化

## 状态

通过。对应 GitHub Issue `#24` 的首个只读切片；审查对象包括客户端 projection/state、请求并发、DOM 渲染、可访问性、响应式布局、静态资源 route、自动化测试和文档边界。

## 独立审查范围

独立前端只读审查覆盖：

1. loading、empty、error、refreshing 与 stale 状态转换；
2. dashboard/Provider 独立 request gate 与乱序响应；
3. schema 校验、diagnostic 裁剪、DOM 转义与审批边界；
4. polling、details/Refresh 键盘交互、aria-live 和焦点保持；
5. 桌面/移动布局、长文本溢出、控制台与测试覆盖。

## Finding 与闭环

### 同 revision 轮询重建 DOM

初始实现把 phase 与 revision 合成一个总渲染键。每次轮询都会经历 `ready → refreshing → ready`，因而两次替换卡片 `innerHTML`，关闭已展开 details、丢失 summary 焦点并重复创建最多 64 张卡片。

现将加载控件与 observation 内容分开渲染；内容键只绑定 `view + revision`。同 revision 刷新仅更新 busy、button、banner 与已有 time 文本，不替换互动节点。纯状态回归验证 ready、refreshing、stale 的内容键一致。

### Empty projection 的 stale 展示

初始 empty model 在刷新失败后会落入普通 model 分支，显示空白 cards 和无意义的 Latest 面板。现以 `model.cards.length === 0` 识别最后成功展示类型，使 empty 在 refreshing/stale 时保持明确 empty state，Latest 继续隐藏。

### 客户端安全契约不足

初始校验使用宽松 `Date.parse` 并接受任意 diagnostic 字符串，也没有完整验证 status、digest、resolution 与 source revision 组合。被篡改或回归的同源响应可能展示错误正文或伪造状态。

现要求 canonical RFC 3339、`startedAt ≤ observedAt ≤ now`，并镜像后端 88 个 safe diagnostic codes；同时限制 key/id/evidence 长度，拒绝重复 source identity，验证 status/diagnostic、snapshot digest 与 operation/resolution 不变量。任一失败会拒绝整份 projection。

### 重复 live announcement

初始 stale banner 与隐藏摘要都是 live region，并在每次自动重试的 refreshing/stale 切换中重复播报。现可见 banner 不承担 live role，隐藏摘要是唯一播报源；refreshing 不发出新摘要，恢复成功时再报告真实语义变化。

### Configured target identity 漂移

复审发现客户端曾把 `configuredTarget.kind` 纳入卡片唯一键，同一 provider/key 可通过伪造不同 kind 生成重复卡片。现与服务端 canonical identity 对齐，只使用 `provider + configuredTarget.key`，并以不同 kind、相同 key 的反例验证整份 projection 失败关闭。

## 架构边界

- 浏览器只访问同源只读 API；没有 Provider client、apply、approval 或 mutation route。
- preview/snapshot ready 不等于 approval required；UI 固定显示 operation journal 尚未接入。
- Provider panel 与 workflow dashboard 使用独立请求序号和轮询节奏。
- projection revision 是内容一致性边界；relative time 可以原位更新，不影响内容 identity。
- public 浏览器脚本保持原生 ESM；本切片不引入框架、构建步骤或生产依赖。

## 验证证据

- Provider client state 与 request gate 定向测试：13/13 通过。
- `npm run typecheck`：通过。
- `npm test`：332/332 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过。
- 桌面/移动浏览器：无横向溢出，五态文本/图形可见，details 与 Refresh 可键盘操作，stale 保留 last-known cards。
- 浏览器控制台 error/warning：0。
- 后端/客户端 safe diagnostic allowlist：88/88 一致。
- 独立前端复审：无剩余 P0–P3。

## 剩余风险

- 当前 latest 列表是每个配置目标的最后 observation，不是逐操作历史。
- operation approval、submitting、outcome unknown、reconciled 与完整 sync failure 仍需 `#6`、`#29`。
- 浏览器 QA 覆盖本地 Chromium 与两个代表视口，尚未做真实屏幕阅读器和跨浏览器矩阵。

## 结论

Issue `#24` 的只读 Provider 可视化切片保持了 read model、workflow journal 和外部写权限的分离，并已关闭审查发现的交互、empty stale、客户端安全和重复播报问题。完整审批/同步时间线仍不能在 operation journal 之前宣称完成。
