# ADR 0017：飞书不透明只读 Scope

## 状态

已接受。

## 背景

飞书多维表格 API 需要 App ID/Secret、`app_token`、`table_id` 与 `record_id`。
App Secret 是凭证，其他 ID 虽不是授权凭证，但直接写入公开仓库、CLI snapshot、
Provider observation 或 Linear 交付评论会暴露专用测试资源坐标。

TaskSeal 又需要一个稳定 configured target，才能让真实 snapshot 的 observed scope
与项目配置精确对账，并在 Control Room 中区分 scope drift。

## 决策

- App ID/Secret、Base/table/record ID 和字段名只从固定
  `TASKSEAL_FEISHU_*` 环境变量读取。
- `config/project.json` 只保存
  `feishu:table:sha256:<digest>`，不保存任何原始飞书 ID。
- table scope、parent Base scope 与 record identity 分别对规范输入计算独立摘要。
- CLI 与 ProviderSnapshot 只输出摘要；source URL 使用飞书 Base 产品入口，不拼接
  资源 ID。
- Adapter 只暴露 `provider.health` 和 `work-item.read`。健康检查固定验证表、字段与
  2+1 分页；记录读取固定验证字段与单记录。
- 飞书加入 Provider observation 的 provider、table scope 和 record revision
  只读模型，但不加入 trusted ingress registry、ImportProvider、ImportPolicy 或
  apply route。

## 结果

项目可以稳定识别配置漂移、展示真实读取状态和 revision/digest，同时仓库、
observation、CLI、PR 与任务系统中都不出现原始飞书资源坐标或凭证。

飞书 snapshot 中的 `candidateEvent` 只是 Provider v2 的事实候选。没有 trusted
ingress registration 时，它不能进入 import plan，更不能写本地 journal 或远端
飞书。

## 被拒绝方案

### 把原始 ID 写入项目配置

实现简单，但会把专用测试资源坐标传播到公开仓库和下游交付证据，不采用。

### 只使用 provider 级 configured target

无法证明 observed table 就是配置预期的 table，会让 observation 永久落入
scope mismatch 或错误接受任意表，不采用。

### 首版同时开放 import

会同时扩大领域模型、ingress validator、ImportPolicy 与 apply 验收范围，无法
隔离验证飞书读取风险，不采用。
