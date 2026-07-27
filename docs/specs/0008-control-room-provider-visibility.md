# 规格 0008：Control Room Provider 可视化

## 目标

让本地操作者在 Control Room 中直接判断已配置 Provider 的当前读取、scope、snapshot、mapping、缺失证据与同步观察状态，并能区分数据正在加载、尚无配置、读取失败、显示旧数据和请求乱序。

本切片对应 GitHub Issue `#24`，只消费 Issue `#23` 已稳定的 `GET /api/providers`。它不新增 Provider 请求、外部写入或本地 apply 入口。

> 2026-07-27 补充：本规格记录 Provider Observation v1 的首个 UI 切片。Issue `#29` 与[规格 0013](0013-provider-operation-projection.md)在不改变只读边界的前提下把同一路由升级为 v2，并接入 Operation Journal 的安全 latest projection；浏览器继续兼容 v1。

## 数据边界

浏览器只读取同源：

```http
GET /api/providers
Cache-Control: no-store
```

响应使用 `ProviderObservationProjection v1`。客户端只展示：

- provider 与 configured target；
- observed scope；
- operation、status、observedAt；
- source revision 数量；
- snapshot、mapping、plan digest 的裁剪显示；
- missing evidence、diagnostic code 与 import resolution。

不得展示或推断标题、正文、URL、凭证、原始响应、错误正文或本地路径。

Demo mode 不请求该 API，Provider 面板保持隐藏。

## 客户端状态

Provider 面板使用独立 request gate，不与 dashboard snapshot 的序号混用：

```text
idle
  → loading
  → ready | empty | error

ready | empty
  → refreshing
  → ready | empty
  → stale-error（保留最后成功数据并显示刷新失败）
```

- 每次请求取得递增序号；只有最新已发出请求可以提交 UI。
- persistent mode 首次识别后立即加载，之后每 5 秒轮询。
- 手动 Refresh 可发起更新，并提供可聚焦的键盘操作。
- 加载控件与 observation 内容使用独立渲染键；同一 revision 的轮询只更新 busy/banner 和相对时间，不替换卡片 DOM，因此不会关闭已展开详情或丢失其键盘焦点。
- 首次失败显示 error empty state；已有成功数据后的失败保留卡片并明确标记“显示最后已知状态”。
- 最后一次成功 projection 为空时，刷新中或刷新失败仍保留 empty state，不显示无意义的空列表。
- 客户端收到结构不合法的 projection 时按读取失败处理，不部分渲染。

## Observation 新鲜度

客户端不设置任意 TTL，也不把一次较早但仍有效的配置观察改写为领域 stale 状态。`Stale` 专指“最近一次刷新失败，当前仍显示最后一次成功 projection”。

卡片始终显示后端 `observedAt` 的绝对时间与相对年龄，由操作者结合业务 SLA 判断是否需要重新 inspection。非 canonical RFC 3339、未来时间、`observedAt < startedAt` 或错误 schema 视为响应无效；diagnostic 只接受与后端一致的安全码 allowlist。

## Provider 卡片

每个 configured target 对应一张卡，必须同时用文本、图标/形状和颜色表达状态：

| 后端状态 | UI 文本 | 主要含义 |
| --- | --- | --- |
| `configured` | Configured | 已配置，尚待有效 snapshot |
| `scope_mismatch` | Scope mismatch | 返回 scope 与配置目标不一致 |
| `sample_missing` | Sample missing | 指定样本不可读取 |
| `snapshot_ready` | Snapshot ready | snapshot 已验证并可供后续流程使用 |
| `sync_failed` | Sync failed | 最近操作失败 |

卡片展示最新 observation 的安全字段；另按 `observedAt` 排序形成 `Latest observations`：

```text
Provider · operation · status · observedAt
```

该列表明确标注为“每个 configured target 的最新记录”，不是历史时间线。它不从 `snapshot.preview`、`planDigest`、`missingEvidence` 或 `snapshot_ready` 推断审批状态，因为成功 preview 仍可能含冲突或不可 apply。

在 v1 响应中，审批区域固定显示 `Operation journal not connected`。v2 响应会按[规格 0013](0013-provider-operation-projection.md)展示 latest operation 的审批、提交、未知结果与对账摘要；仍不提供浏览器写按钮，也不把 latest projection 冒充完整历史时间线。

## 汇总与可访问性

面板头部显示 Provider 总数、ready 数和 attention 数，并明确审批状态尚未接入。可见 stale banner 不单独承担 live role，由唯一的 `aria-live` 摘要在语义状态变化时报告：

- Provider 数量；
- 每个 Provider 的文本状态；
- stale 与 missing evidence；
- 刷新失败且正在显示最后已知数据。

卡片、状态徽标和同步路径不能仅依赖颜色。所有按钮有可见 focus，移动端不产生横向溢出，技术 key/digest 可换行。

## 响应式布局

- 宽屏：最多三列 Provider 卡片；
- 中屏：两列；
- 小屏：单列，头部操作纵向排列，同步路径仍完整显示文本。

## 验收

1. persistent Control Room 能展示全部 Provider 卡片、五态和最新观察时间。
2. UI 不从 preview observation 猜测审批；v1 明确显示 operation journal 尚未接入，v2 只消费独立的安全 operation projection。
3. loading、empty、first-error、stale-error 和 stale observation 均有明确文本。
4. 较旧请求晚返回时不能覆盖较新结果。
5. demo mode 不请求 Provider API。
6. 桌面与移动浏览器无横向溢出、无控制台错误，键盘可触发 Refresh。
7. 自动化测试、浏览器走查、可访问性检查和独立前端审查通过。
