# 规格 0020：GitHub 交付证据对账

## 状态

已实现。对应 Linear `NP-6` / T18。

## 目标

从仓库内显式声明的 `Linear Issue UUID → WorkItem → PR head → Evidence criterion` 映射出发，只读采集 GitHub PR、Check Run 和 Review，把同一 PR head 归一为一个 Artifact 与最多七项 Evidence，并通过既有 Snapshot Import、远端 provenance 回读和原子 journal batch 形成可复核交付链。

本切片移除手工输入 PR/check 编号组合，但不做 PR 自动发现，不合并 PR，不更新或评论 GitHub/Linear，也不把 Agent 文本当作 Evidence。

## 术语

- **DeliveryMapping**：仓库版本化的关联意图；它只声明允许对账的对象，不证明 GitHub 当前事实。
- **target repository**：PR 所属 base repository，对应项目 `github.repository`。
- **head identity**：PR 的 `headRepository + branch`，允许 fork PR，但必须与实时 PR 精确一致。
- **head revision**：实时 PR `head.sha`；它同时是 Artifact revision 和 Evidence revision。
- **head fence**：采集 Evidence 后再次读取同一 PR，并精确比较 ID、number、URL、updated time、head SHA、head repository 和 branch。
- **selector identity**：经过审阅的 Check `name + appId` 或 Review `reviewerId`；它与 provider object key 一同进入 snapshot mapping，不能只凭远端 numeric ID 推断。

## 配置与映射

项目配置必须显式启用并指向仓库相对 JSON：

```json
{
  "github": {
    "repository": "owner/repository",
    "delivery": {
      "enabled": true,
      "mappingIndex": "config/github-delivery-map.json"
    }
  }
}
```

映射文件使用固定 schema：

```json
{
  "schemaVersion": 1,
  "provider": "github",
  "target": {
    "repository": "owner/repository"
  },
  "entries": [
    {
      "linearIssueId": "00000000-0000-4000-8000-000000000000",
      "workItemId": "TS-1",
      "headRepository": "owner/repository",
      "branch": "feature/example",
      "pullRequestNumber": 1,
      "evidence": [
        {
          "criterionKey": "tests",
          "source": {
            "kind": "check_run",
            "name": "test",
            "appId": "15368"
          }
        },
        {
          "criterionKey": "review",
          "source": {
            "kind": "pull_request_review",
            "reviewerId": "12345"
          }
        }
      ]
    }
  ]
}
```

约束：

- index 最大 512 KiB、200 entries；每项必须包含 1～7 个不同 criterion。
- Linear UUID、WorkItem、target PR 和 `headRepository + branch` 在 index 内唯一。
- Check selector 由精确 name 与可选 GitHub App numeric ID 组成；Review selector 使用精确 reviewer numeric ID。
- 路径必须是仓库内相对 `.json` 文件；绝对路径、反斜杠、ADS、路径逃逸、符号链接和读取期间文件替换均失败关闭。
- `target.repository` 必须与项目配置大小写归一后精确一致；空 entries 是合法的安全 bootstrap，不触发自动发现。

## 对账流程

1. 在网络请求前读取 mapping，并验证本地 WorkItem 只由同一 `linear:issue:<uuid>` rich link 拥有。
2. WorkItem 的 required evidence 集合必须与 mapping criteria 完全相同；使用当前 active、`running|completed` Attempt。
3. 按 target repository 与 PR number 读取 PR，并精确核对 head repository 和 branch。
4. 以 PR head SHA 批量读取配置的 Check Run；缺失、未完成或 pending 不生成 Evidence，也不伪装失败。
5. 每个 reviewer 只选择当前 head 上的最新 decisive review；排序为 `submitted_at` 后 numeric review ID。`APPROVED` 为 passed，`CHANGES_REQUESTED` 和 `DISMISSED` 为 failed；`COMMENTED`、`PENDING`、旧 head 或无匹配项均视为缺失。
6. 再次读取 PR 执行 head fence；任一字段漂移时不生成计划、不写 journal。
7. 生成包含 PR Artifact fact 与当前可用 Evidence facts 的 ProviderSnapshot v2，由 Snapshot Import 产生确定性 ImportPlan。
8. apply 在同一次命令内重新采集并重建计划；只有 digest 与人工审阅值相同才进入 provenance verifier 与原子 batch。
9. 已提交 digest 的重试先用当前 index 与 journal 重建 mapping digest；只有当前 active Artifact、Evidence selector、canonical actions 和 event IDs 全部一致才离线返回 receipt，否则以 stale 失败且不访问 GitHub。

## 缺失证据与 head 漂移

- 新 head 即使尚无完整 Evidence，也必须先形成 Artifact plan。这样旧 head Evidence 和既有 AcceptanceDecision 不会继续作用于新 revision。
- 缺失 criterion 出现在安全 projection 的 `missingEvidence`，不会生成失败 Evidence。
- 同一远端事实已在 canonical workflow 中表示时，preview 返回 `up_to_date`，不提交空 batch。
- Check snapshot 同时绑定配置 selector、远端实际 `name + appId` 与采集时的 `pull_request.updated_at`；delivery source revision 对四者做复合摘要。provenance 重读 exact Check Run 和 mapped PR，以 final PR URL、`updated_at` 与 head 重算摘要；因此并行 claim 期间的 `H → H2 → H` ABA 会因 revision time 漂移失败，而旧 Artifact 为 T1、实时同-head PR 为 T2 的 Evidence-only plan 可以正确按 T2 验真。
- Review provenance 先重读 exact review，再读取 PR 作为最终 fence，核对 review ID、reviewer、state、URL、commit SHA、当前 PR head、PR revision time 和内容 digest。
- 含 Review 的 import batch 持久化 `PolicyBindingV3`；第一条 v3 batch 是单向 reader fence，之后不得回退到仅认识旧 v1/v2 binding 的二进制。

## CLI 合同

```bash
node src/cli.ts reconcile github \
  --mode preview \
  --work-item <id>

node src/cli.ts reconcile github \
  --mode apply \
  --work-item <id> \
  --expected-plan-digest <sha256>
```

preview 只读 GitHub 和本地 journal；apply 只可能写本地 canonical journal。两种结果都明确返回 `githubWrites: 0` 与 `linearWrites: 0`。配置关闭时零网络；错误输出使用固定脱敏文案。

## 失败边界

- mapping 缺失、scope/ownership/criteria/Attempt 漂移均在 GitHub read 前失败。
- 同一个远端 Evidence 对象命中多个 criterion 时失败，不复制证据。
- PR 采集竞态返回 `GITHUB_DELIVERY_REVISION_RACE`。
- apply 期间计划、workflow、policy 或远端 provenance 漂移均零 journal 写入。
- 旧 head 的 committed digest 在新 head 提交后固定 stale；当前 head 的 digest 仍可在集成关闭、无凭证时零网络幂等重放。
- 同一 PR timestamp 下出现无法排序的新 head 或相反 Evidence outcome 时沿用 Domain 的 ambiguous-order 失败关闭语义。

## 验收

1. 一个显式 PR head 可原子计划 Artifact、Check Evidence 和 Review Evidence。
2. 同一 revision 重复对账返回 `up_to_date`，journal 不增加记录。
3. head 漂移立即切换 active Artifact，旧 Evidence 不再满足验收。
4. 缺失 required Evidence 时不能 accepted。
5. 采集期间或 apply provenance 期间 PR head 漂移失败关闭。
6. disabled、foreign target、missing binding 和本地映射冲突均为零 GitHub 请求。
7. CLI/runtime 不具备 merge、comment、issue update 或 Linear mutation 能力。
8. Check/Review selector identity 被 snapshot、plan 与 apply-time provenance 共同绑定；篡改 name、appId 或 reviewerId 时失败关闭。
9. 先提交 head H、再提交 H2 后，H receipt 重试 stale 且零网络，H2 receipt 重试 idempotent 且零网络。
10. Artifact 与 Check claim 并行验真期间，即使 PR head 从 H 变化后又回到 H，只要 PR revision time 已变化就必须 mismatch。
