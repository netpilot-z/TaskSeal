# 规格 0025：飞书有界只读 Client

## 状态

已实现。

## 目标

在不引入生产依赖、不授予 Base 写能力、不把凭证交给 Runner 的前提下，验证
TaskSeal 能用企业自建应用身份读取一个固定飞书多维表格、动态校验字段映射、
遍历小规模分页并归一一个固定记录。

本切片只建立 Connector 层 Client。Provider Adapter、CLI、observation 和控制室
接线由后续任务完成。

## 输入

Client 构造时只接受：

- `appId`
- `appSecret`
- 可选的 `fetchImpl`、最长 15 秒 timeout 和测试 clock

每次读取必须显式提供：

- `appToken`
- `tableId`
- `fieldMapping.title`
- `fieldMapping.status`
- `fieldMapping.updatedAt`

单记录读取还必须提供固定 `recordId`。所有对象拒绝 unknown field、accessor、
symbol key、非 plain object、越界字符串与非规范资源标识。

## 允许的网络操作

| 目的 | 方法 | 固定路径 |
| --- | --- | --- |
| 获取短期 token | POST | `/open-apis/auth/v3/tenant_access_token/internal` |
| 校验数据表 | GET | `/open-apis/bitable/v1/apps/:app_token/tables` |
| 校验字段 | GET | `/open-apis/bitable/v1/apps/:app_token/tables/:table_id/fields` |
| 分页查询记录 | POST | `/open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/search` |
| 读取固定记录 | GET | `/open-apis/bitable/v1/apps/:app_token/tables/:table_id/records/:record_id` |

不存在任意路径请求，也不实现新增、更新、删除、批量写或 Webhook。
`records/search` 的 POST body 固定为 `{}`，只是飞书当前推荐的查询接口，不具有
写语义。

## 字段合同

字段名称来自环境配置，不写死在 Client 中；读取前必须在服务端字段列表中精确、
唯一匹配，并满足：

- title：飞书字段类型 `1`（文本）
- status：飞书字段类型 `3`（单选）
- updatedAt：飞书字段类型 `5`（日期）

输出只保留 `recordId`、`title`、`status`、标准 RFC 3339 `updatedAt`。未映射字段
即使出现在原始 payload 中也不会进入归一结果。

## 边界

- HTTP response 最多 256 KiB；支持 `content-length` 预检和流式提前终止。
- timeout 最长 15 秒；即使自定义 fetch 忽略 `AbortSignal`，Client 也拥有最终
  deadline。
- 表和字段分页最多 2 页；记录查询固定 `page_size=2`，最多 8 页、16 条。
- 重复 page token、重复 record ID、total 漂移、分页环和目标 scope 漂移均失败
  关闭。
- 分页 token 视为有界不透明值并通过 `URLSearchParams` 编码，不套用资源 ID
  规则。
- token 请求并发合并；进入官方建议的 30 分钟刷新窗口后重新获取。

## 敏感信息规则

- App Secret 只出现在 token 请求 body。
- `tenant_access_token` 只存在于 Client 私有缓存和飞书请求 Authorization
  header。
- 返回值、错误消息、测试快照、文档和日志不包含 App Secret 或 token。
- 飞书业务错误的 `msg` 与 transport 原始异常不会穿透稳定错误边界。

## 验证

自动化测试覆盖：

- token 并发合并与刷新
- 固定 HTTP 方法和路径
- 2+1 分页
- 动态字段类型校验与额外字段裁剪
- page token 环、scope drift 和越界 response
- 原生 `Response`、忽略 signal 的 fetch 与错误脱敏

真实只读验收使用专用测试 Base，确认一个表、五个字段、三条记录、2+1 分页和
固定记录归一；不执行任何写请求。
