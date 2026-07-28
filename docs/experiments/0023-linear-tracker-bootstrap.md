# 实验 0023：Linear Tracker Bootstrap

- 关联：Linear `NP-1`
- 规格：`docs/specs/0016-linear-tracker-bootstrap.md`
- 日期：2026-07-28

## 假设

1. 在不修改 Operation v1 和不执行 mutation 的前提下，可以只读证明目标 Organization、Team、Project 和 Backlog State 的关系。
2. 一个零生产依赖的 GraphQL exchange 可以同时满足固定 endpoint、单凭证、总 timeout、request/response byte limit 和 post-dispatch uncertainty fence。
3. 当前未完成产品待办可以生成确定性 dry-run，同时排除历史已完成项和已有 `NP-1` 映射的 T15.1。

## TDD 证据

首轮测试先因缺少以下接口而红灯：

- `getLinearBootstrapCoordinates`；
- `linear-bootstrap-scope`；
- `linear-graphql-http-exchange`。

实现 fake 合同后，第一次真实只读 smoke 又暴露原生 `fetch Response` 的 `status/body` 位于 prototype getter，而测试 fake 使用 own property。修复后新增原生 `Response` 回归。

独立审查随后用连续空 chunk 复现 streaming loop 可饿死 timer。新增两条红灯用例：

- zero-length chunk 被错误接受为空响应；
- 连续立即 resolved 的非空微任务流直到 byte limit 才停止，没有执行总 deadline。

修复后 exchange 从 fetch 前建立 monotonic deadline，在每次 stream read 前后检查，并拒绝 zero-length chunk。

## 实现结果

- 配置显式加入 `linear.project` 和 `linear.backlogState`，既有 workspace/team accessor 保持兼容。
- dry-run 的 Project 语义不再借用顶层本地项目名。
- 默认 source 改为 `0006-linear-bootstrap-manifest.md`，并过滤以“已完成”或 `completed` 开头的状态。
- resolver 对四类 connection 使用 50 nodes / 20 pages 上限，校验重复游标、同 ID identity drift、对象歧义、Project-Team 关系和 backlog state type。
- HTTP exchange 固定 Linear GraphQL endpoint、POST、redirect error、单凭证、15 秒最大 timeout、128 KiB request 和 64 KiB streaming response。
- 新模块没有注入 Coordinator、CLI/HTTP command 或 Control Room，不产生真实写权限。

## 真实只读 smoke

使用当前 `LINEAR_API_KEY` 执行 resolver，只调用固定 GraphQL query，成功解析：

```text
workspace  = netpilot-z
team       = netpilot (NP)
project    = TaskSeal
state      = Backlog
```

返回的 Organization、Team、Project 和 State UUID 与前期只读审计一致。执行路径不包含 mutation，Operation Journal 和 canonical journal 均未参与。

实验实施时，旧凭证 mutation probe 返回 `FORBIDDEN`，因此代码切片没有创建、更新或关闭 Linear Issue。随后操作者补充了 Issue 创建、更新和评论权限；`NP-1` 已通过精确 UUID update 与读后核验确认权限生效。这个管理性动作不改变本切片“未接入 TaskSeal runtime mutation”的边界。

## 验证结果

- `npm test`：627/627 通过，包含 `tsc --noEmit`。
- `git diff --check`：通过，仅有工作区换行提示。
- ControlledWriteOperation v1、Operation Journal replay 和 Coordinator fake 回归全部保持绿色。
- 独立后端复审确认 empty-chunk/timeout 问题关闭，未发现新的 P0–P3。

## 结论

假设 1、2、3 均得到支持。Project/State 已可被安全解析，但不能旁路注入 v1 写链。下一步必须先引入 reader-first 的 Linear Operation v2，再开放 prepare-only bootstrap；真实 submit 继续受显式能力、逐项人工审批和 journal 门禁。
