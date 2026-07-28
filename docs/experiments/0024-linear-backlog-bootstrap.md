# 实验 0024：Linear Backlog Bootstrap

## 目标

验证获授权的管理性操作能否把仓库内未映射待办迁移到 Linear，并以稳定 UUID、读后核验和 GitHub 迁移记录形成可恢复审计链。

## 执行

1. 在任何创建请求前，将 11 个 client UUID、source ticket、标题、payload digest、目标 Team/Project/State 和父任务写入 `docs/tickets/0007-linear-bootstrap-map.json` 并提交。
2. 先创建 `NP-2` 作为 pilot，再逐项创建 `NP-3`～`NP-12`；每次都按 client UUID 回读，不使用标题去重。
3. 核验每张 Issue 的 Team、Project、Backlog State、父任务、标题与描述。Linear 会把 Issue 描述中的 Markdown 无序列表标记从 `-` 规范化为 `*`，映射中显式记录了该规则。
4. 将 `NP-2` 迁移到 `In Progress`，将独立可读切片 `NP-4` 迁移到 `Todo`，并在 `NP-1` 创建带稳定 UUID 的汇总评论。
5. 在 GitHub `#7`、`#25`、`#32` 留下对应 Linear 链接，回读确认后以 `not planned` 关闭。
6. 尝试为依赖 DAG 创建第一条原生 `blocks` 关系；API 返回 `Invalid scope: write required`，按失败关闭规则停止其余关系写入。
7. Issue 创建、更新和评论权限扩展后，使用相同预存 relation UUID 对第一条关系做一次受控重试；仍返回 `FORBIDDEN`，0 条关系被创建，因此没有继续派发其余 10 条。

## 结果

- 11/11 个 Linear 子任务创建并回读核验成功，identifier 为 `NP-2`～`NP-12`。
- Issue 创建、更新和评论权限可用；所有记录均绑定 Team `netpilot`、Project `TaskSeal` 和父任务 `NP-1`。
- GitHub 三张内部规划 Issue 已完成链接迁移和关闭，内部执行状态不再由 GitHub Issue 承载。
- 原生依赖关系为 0/11：预存关系 UUID 和方向仍保留在映射中，但当前凭证缺少该 mutation 所需的通用 `write` scope。
- `0006-linear-bootstrap-manifest.md` 已清空；默认 `sync linear --dry-run` 返回 0 张草案和 0 次外部写入。
- Operation v2 合并后再次回读：11/11 Issue 仍精确绑定目标 Team、Project 和父任务；`NP-2` 为 `Done`、`NP-4` 为 `Todo`、其余为 `Backlog`。GitHub `#7`、`#25`、`#32` 仍为 `not planned` closed。

## 结论

Linear 已可作为当前产品待办主账本，且真实创建、更新、评论与迁移路径得到验证。原生 relation 不是完成本次主账本迁移的必要条件；依赖 DAG 暂时只能从 Issue 描述和仓库映射读取，不能宣称已建立 Linear 原生关系。补充通用 `write` scope 后，应复用映射中的 relation UUID 继续对账，而不是重新生成关系计划。
