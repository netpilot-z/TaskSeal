# ADR 0009：用独立 Ready Reader 组合既有 Snapshot Import

- 状态：Accepted
- 日期：2026-07-28

## 背景

现有 CLI 只能运行已知本地 WorkItem，Control Room 前端还固定选择排序后的第一项。Linear 单 Issue reader 不读取 Project、State 或 blockers；bootstrap resolver 又只允许 Backlog state。直接把 Todo query 塞进 Runner，或用 legacy `work_item.created` 直接 append，会绕过 rich ingress、ImportPolicy、provenance 与原子 batch。

原生 Linear Issue relation 的 create API 仍返回 `FORBIDDEN`，但 bootstrap map 已保存评审过的稳定 UUID 依赖边。

## 决策

新增三层窄边界：

1. connector-owned ready reader：解析 exact Project/Todo/Done scope、有界读取 Todo Issue、观察原生 blocker 与依赖状态；
2. connector-owned dependency index：严格把 bootstrap ticket DAG 转为 UUID 边，并把 map target 的 Organization/Team/Project UUID 与 resolved scope 精确绑定；只把完成状态交给 Linear 实时回读，未被历史索引覆盖的新 Issue 使用完整的原生 relation，不视为未知；
3. application-owned coordinator：计算 `ready/blocked/unknown`，要求 UUID 显式选择，再复用 ProviderSnapshot v2 与 Snapshot Import。

NP-4 不新增 ready queue、Domain Event 或 Runner API。CLI 提供 list、preview、apply；apply 只更新本地 journal 且保持零 Linear mutation。真正的运行、取消、重试与并发控制留给 T17。

## 结果

- 同一 Linear UUID 继续由 `ProviderObjectKey` 全局唯一约束；
- provider-managed local write 仍必须经过 policy、provenance 与 atomic import；
- blocker 不完整、状态未知或非精确 Done 时失败关闭；
- bootstrap map 只为已覆盖 Issue 补充关系拓扑，不是 ready-work allowlist，也不拥有在线状态；
- foreign 或缺失的 map target 在读取候选 Issue 前失败关闭，不能通过 `unindexed` 静默降级；
- list 路径不打开 canonical journal；preview/apply 才组合 Snapshot Import；
- apply 先从 journal 恢复 reviewed digest 对应的 receipt context；精确绑定 provider/scope/source/work-item/mapping 后可离线返回，未命中才访问 Linear；
- list 与 apply 之间不存在 Linear 原子锁，apply 前重读将竞态窗口缩小但不承诺租约；
- 删除 ready-work composition 或关闭配置即可回退，persisted schema 不变。

## 未选择的方案

- 扩展旧 single-Issue reader并直接 append：会绕过已建立的 ingress 决策；
- 从标题或描述推断依赖：身份与关系不可复核；
- 立即引入后台轮询队列：会提前制造第二套任务状态和持久化迁移；
- 等待原生 relation 权限后才实现：会阻塞可独立验证的读取与本地映射闭环。
