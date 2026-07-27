# 实验 0015：Control Room Provider 可视化

## 实验卡

- 决策：能否只消费脱敏 Provider Observation API，在不增加浏览器写入口和生产依赖的前提下，让操作者可靠判断 Provider 当前状态。
- 假设：五态卡片、独立请求序号、last-known stale 语义和严格客户端投影校验，足以覆盖首个本地 Control Room 读侧闭环。
- 反证：demo 模式访问 Provider API；旧请求覆盖新结果；preview 被误报为待审批；刷新失败清空已知数据；诊断正文或凭证被展示；轮询破坏键盘焦点；移动端横向溢出或控制台报错。
- 指标：纯客户端状态测试、HTTP 静态资源回归、桌面/移动浏览器走查、键盘与控制台检查、全量测试和独立前端审查。
- 边界：本切片不提供 operation history、审批、外部提交、对账或浏览器写 API；这些状态必须等待 Issue `#6` 与 `#29` 的 operation journal。

## Red

初始 Control Room 只有 canonical workflow dashboard，没有：

1. `GET /api/providers` 的浏览器消费和独立请求序号；
2. configured、scope mismatch、sample missing、snapshot ready、sync failed 五态视图；
3. loading、empty、first error 与 last-known stale 状态；
4. 适配桌面/移动端且不只依赖颜色的 Provider 卡片；
5. 对后端安全 projection 的客户端 fail-closed 校验。

新增测试先因 Provider client model、静态资源 route 与独立 request gate 缺失失败。独立审查进一步构造了 unsafe diagnostic、错误时间顺序、未来时间、非法 resolution 和重复 source revision 等反例，并发现同 revision 轮询会重建卡片 DOM。

## Green

- persistent mode 首次加载后每 5 秒同源读取 `GET /api/providers`；demo mode 与非 persistent 状态不发起 Provider 请求。
- Provider 请求使用独立 request gate，只有最新已发出请求可以提交 UI，不会干扰 dashboard snapshot。
- 卡片展示配置目标、observed scope、operation、五态、绝对/相对观察时间、source revision 数量、裁剪 digest、缺失证据和安全诊断码。
- `Latest observations` 只排序每个目标的最新 observation，并明确标记不是历史日志。
- UI 不从 `snapshot.preview`、plan digest 或 snapshot ready 推断审批，固定说明 operation journal 尚未接入。
- 第一次失败显示 error；已有非空或空 projection 的刷新失败均保留上次成功展示并显示 stale banner。
- 内容渲染键只绑定视图类型与 projection revision；同 revision 的 refreshing/stale 只更新控件、banner 和原位时间文本，不替换卡片 DOM。
- 客户端要求 canonical RFC 3339、时间单调且不在未来，并镜像后端 safe diagnostic allowlist、status/diagnostic、snapshot digest、operation/resolution、长度与 source identity 不变量。
- visible stale banner 不再承担 live role；唯一隐藏摘要只在真实语义变化时播报，refreshing 不重复播报。

## 浏览器证据

- 宽屏视口下展示 GitHub、Linear、Gitee 三张卡；1 个 snapshot ready、2 个 attention，状态均有文本和图形。
- 移动端内容宽度与文档宽度一致，卡片为单列，长 key/digest 无横向溢出。
- 原生 details 可通过键盘聚焦和切换；Refresh 为可聚焦按钮。
- 停止本地服务后，自动刷新进入 stale，三张 last-known 卡片保留且 banner/aria 摘要明确失败。
- 浏览器控制台 error/warning 为 0。

## 验证证据

- Provider client state 与 dashboard request gate 定向测试：13/13 通过。
- `npm run typecheck`：通过。
- `npm test`：332/332 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过。
- Provider 前后端 safe diagnostic allowlist：88/88 完全一致。
- 生产依赖保持为 0。

## 结论

支持实验假设。TaskSeal 已具备可审查的 Provider 读侧 Control Room：操作者能在桌面和移动端看到安全五态、scope、snapshot、mapping、缺失证据与 stale 状态；浏览器不会发起外部写入，也不会伪造审批。完整审批与同步生命周期继续由 `#6`、`#29` 提供。
