# 实验 0014：Provider Observation 读模型与只读 API

## 实验卡

- 决策：能否在不保存 Provider 原始响应、不扩大 import 写入权限和不新增生产依赖的前提下，持久化跨 Provider 的安全运行摘要，并向 Control Room 提供统一只读查询。
- 假设：以配置目标为 identity、以操作开始时间判定新鲜度、以严格投影裁剪数据后，GitHub、Linear 与 Gitee 可以共享一个 bounded read model；inspection 和 snapshot import 的真实路径可通过 coordinator 记录结果而不改变原有返回值、错误与提交语义。
- 反证：原始标题、正文、URL、路径或异常文本进入存储/API；较晚完成的旧操作覆盖新状态；同一时刻的冲突结果静默覆盖；Linear scope 只凭 UUID 形状获得信任；观察失败阻断真实 Provider 操作或 snapshot commit；损坏或逃逸的状态文件被静默接受。
- 指标：领域规则、持久化安全、coordinator、真实 preview/apply、CLI、runtime 与 HTTP API 自动化测试，全量测试和独立后端/安全审查。
- 边界：本切片只提供运行摘要、状态机与 `GET /api/providers`；不含 Control Room 可视化、operation journal、写 API、动态插件加载或新的外部写权限。

## Red

初始代码具备 Provider inspection 和 snapshot import，但没有：

1. 跨 Provider 的统一 observation identity、状态、新鲜度和幂等规则；
2. bounded、atomic 且限制在工作区状态目录内的本地存储；
3. 在不改变原操作语义的前提下记录成功、scope mismatch 与安全失败的 coordinator；
4. 把真实 preview/apply 服务接入观察层的受约束门面；
5. 持久化 runtime 和只读 Provider API。

新增测试先分别因缺少 read model、存储、coordinator、import facade、runtime factory 和 HTTP route 失败。安全与后端审查又补充了 Junction 逃逸、读取期间文件增长、非标准数组原型、宽松时间解析、scope 绑定与真实服务接线等反例。

## Green

- observation identity 由 `provider + configuredTarget.kind + configuredTarget.key` 构成；最多保存 64 个配置目标，不做静默淘汰。
- 状态限定为 `configured`、`scope_mismatch`、`sample_missing`、`snapshot_ready` 和 `sync_failed`，只存 revision、digest、缺失证据键与固定诊断码等 allowlist 字段。
- 时间戳必须是有效 RFC 3339，写入前统一为 UTC；较新的 `startedAt` 提交，较旧结果忽略，同一时刻同一摘要幂等、不同摘要拒绝。
- snapshot scope 从受验证的 payload 投影；GitHub repository 必须精确匹配，Linear 必须由同一配置快照或显式验证的绑定证明，不能仅凭 UUID 形状建立信任。
- coordinator 在真实操作前捕获开始时间，在操作完成后 best-effort 记录；观察 sink 失败不会替换真实返回值或真实错误。
- `ObservedSnapshotImportFacade` 在读取 policy 或调用真实 preview/apply 服务前校验 provider/scope，并在服务返回后再次校验 plan；apply 继续使用原有 tamper validation 和 `TaskSealService` 提交路径。
- `.taskseal/provider-observations.json` 使用 256 KiB 上限、单一确定性 `wx` 临时槽、同步与原子 rename；写入前后复核目录 identity，拒绝 Junction/symlink、越界路径、非普通目标、hardlink swap、损坏 JSON、重复 identity 和读取期间增长。rename 前失败最多保留一个 mode 0600 临时文件，避免不安全清理和无界残留。
- 持久化 Control Room 启动时打开 observation runtime；`GET /api/providers` 返回固定 schema 和 `Cache-Control: no-store`，demo、其他 method 与写 route 均不开放。
- 独立的 `taskseal run` 不打开 observation storage，保持单工作项执行路径的原有边界。

## 安全与架构闭环

审查期间发现并关闭了以下风险：

1. observed scope 曾可从配置目标复制，现改为从受验证的 snapshot/health 结果归一化并精确对账；
2. observation 曾只由测试回调模拟，现由生产 `ObservedSnapshotImportFacade` 包装真实 preview/apply 服务；
3. 等价 RFC 3339 offset 曾产生冲突，现统一 UTC 后参与摘要与新鲜度判断；
4. 状态目录 Junction 可把写入重定向出工作区，现记录并持续复核 canonical path 与目录 identity；
5. 文件可在 stat 后增长并触发无界读取，现使用 `limit + 1` 的 bounded read loop；
6. 自定义数组原型可在归一化时执行用户代码，现仅接受标准 dense array；
7. 宽松日期解析可让非 RFC 文本进入时间字段，现采用严格格式与日历校验；
8. provider-bound facade 曾在真实 service 之后才暴露跨 Provider/scope 计划，现把 descriptor-safe preflight 与 exact plan check 放在任何 policy、journal 或 commit 副作用之前；
9. Linear 曾把 UUID 形状视作 scope 证明，现要求显式、已验证的 bound scope。
10. 失败清理曾可能在目录被换成 Junction 后删除工作区外同名文件；移除 path-based cleanup 后，随机临时文件又可能无界累积，最终改为单一确定性 `wx` slot，失败关闭且残留上限为一份。

## 验证证据

- observation、storage、coordinator、facade、runtime 与 server 定向测试：通过。
- `npm run typecheck`：通过。
- `npm test`：323/323 通过，0 fail、0 skipped、0 todo。
- `git diff --check`：通过。
- 生产依赖保持为 0。
- 路径与凭证扫描未发现开发者机器绝对路径或 Token；唯一 URL 命中为测试中的本地监听地址。

## 结论

支持实验假设。TaskSeal 已具备可复核的 Provider Observation 后端切片：真实 inspection 与受约束的 snapshot import 能生成安全、持久、不会被旧操作倒灌的运行摘要，Control Room 可以通过统一只读 API 消费；UI 可视化留给 Issue `#24`，逐操作审计与追踪留给 Issue `#29`。
