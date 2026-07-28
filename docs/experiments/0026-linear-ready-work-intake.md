# 实验 0026：从 Linear 领取 Ready Work

## 假设

在不增加生产依赖、不修改 Linear、不新增持久 schema 的前提下，可以把 Project/Todo Issue、依赖状态、stable UUID mapping 与现有 Snapshot Import 组合成可复核的本地接入闭环。

## 实现

- `linear.readyWork` 显式配置 Todo、Done、开关与依赖索引；
- scope resolver 同时验证 Project-Team、Todo `unstarted` 与 Done `completed`；
- ready reader 使用 exact UUID filter、50×20 有界分页、客户端 scope 对账和 inverse blocker 归一；
- bootstrap dependency index 严格验证 target scope、ticket/UUID/relation 对应、安全路径段、ADS/保留名、canonical path 与 512 KiB 读取上限；foreign/missing target 在 Issue 读取前停止，正确 scope 中未覆盖的新 Issue 才由完整 native relation 判定；
- coordinator 合并 native/declared blockers，并实时读取依赖状态；
- CLI 提供 list、preview、apply，单票 apply 复用 Snapshot Import 与 provenance。

## 结果

- 自动化测试：全量 `npm test` 682/682 通过；
- 类型检查：`npm run typecheck` 通过；
- 真实只读 smoke：`node src/cli.ts ready linear` 成功解析 workspace `netpilot-z`、team `netpilot`、project `TaskSeal`、Todo 与 Done；当时 Todo 候选为 0；
- smoke 前后 `.taskseal/events.jsonl` hash 相同；
- GraphQL 文档中没有 mutation，CLI apply 明确输出 `linearWrites: 0`；
- 同 UUID 首次 create/link 形成一个 atomic import batch，重复 preview 与 reopen 返回 `already_linked`；重复 apply 在任何配置、凭证或网络访问前恢复 batch context，只有 receipt、provider/scope/source/work-item/mapping 全部匹配才返回 `idempotent`，不追加空 batch；
- blocked、unknown、foreign scope、stale digest 均在本地 import 前停止。

## 结论

T16 技术假设成立。TaskSeal 已能把 Linear 当作 ready-work 来源并安全物化一张本地 WorkItem。下一步 T17 应把该显式选择能力接入 Control Room，移除固定第一项、增加 per-run 状态、cancel、retry 与 bounded concurrency；不需要重写本次 reader 或 Snapshot Import。

## 已知边界

- 原生 relation 尚未回填；bootstrap index 是临时的 UUID topology port；
- T15.1 未迁移为 map entry，因此已在索引中声明依赖它的 NP-4 历史拓扑为 unknown；不在索引中的新 Issue 不受此影响，使用原生 relation；
- Project/Todo/依赖是 apply 前即时 eligibility，不是 Linear 原子租约；
- multi-process local journal CAS、后台 polling 与自动 runner dispatch 不在本实验范围。
