# 规格 0006：Gitee 只读 Adapter 与插件契约

> 后续状态：本文保留 Issue `#10` 的只读切片合同。完成统一门禁后的当前 Gitee 本地 import 行为由 [规格 0014](./0014-provider-ingress-gate.md) 定义；Gitee 外部写回仍不在范围内。

## 背景

TaskSeal 已有 GitHub、Linear 的只读 inspection、ProviderSnapshot v2 和受 ImportPolicy 约束的原子导入。第二个 repository/work-item Provider 用来验证稳定的扩展边界，但当前 rich ExternalLink journal ingress 仍由领域 Provider allowlist 保护，snapshot apply 也是全局 capability。若在本切片直接开放 Gitee import，会扩大未经 registry gate 和 per-scope 授权保护的写入面。

本规格落实 ADR 0003 和 GitHub Issue `#10`：Gitee 只提供匿名公开仓库的健康检查与单 Issue 读取，输出可展示的 ProviderSnapshot v2；它不获得 import、apply、append 或任何外部写入能力。

## 目标

- 定义静态、进程内、版本化的 `AdapterManifest v1` 与两个只读 port。
- 匿名检查一个显式 Gitee repository scope。
- 匿名读取一个显式、区分大小写的 Gitee Issue reference。
- 生成裁剪后的 ProviderSnapshot v2 和 rich candidate event。
- 证明 snapshot preview、伪造 plan apply 和 candidate direct append 都失败关闭。
- 保持 GitHub、Linear、legacy replay 和现有 import 行为兼容。

## 非目标

- Token、OAuth、私有仓库、Issue list、PR、CI、Webhook、评论、状态迁移或关闭 Issue。
- Gitee snapshot import、领域 Provider-agnostic 重构或 per-scope apply。
- 动态发现、下载或执行第三方插件代码。
- 插件市场、npm SDK、远程 Agent runtime、NestJS 或 monorepo。
- Control Room UI；本切片的“展示”指 inspection/CLI 输出的裁剪 JSON。

## AdapterManifest v1

首版 contract 位于受信任的仓库内模块，manifest 只描述能力和边界，不触发动态加载：

```ts
interface AdapterManifestV1 {
  schemaVersion: 1;
  apiVersion: "taskseal.provider/v1";
  providerId: string;
  capabilities: readonly (
    | "provider.health"
    | "work-item.read"
  )[];
  configuration: {
    schemaVersion: 1;
    fields: readonly {
      key: string;
      type: "repository-coordinate";
      required: boolean;
      secret: boolean;
    }[];
  };
  credential: {
    mode: "none";
  };
  scopes: readonly {
    kind: "repository";
    objectTypes: readonly ["issue"];
  }[];
}
```

Gitee manifest 必须精确声明：

- `apiVersion = "taskseal.provider/v1"`、`providerId = "gitee"`；
- capabilities 只有 `provider.health`、`work-item.read`；
- 唯一配置字段为非敏感的 `repository`；
- credential mode 为 `none`，没有 credential reference；
- 唯一 scope kind 为 `repository`，唯一 object type 为 `issue`。

`ProviderAdapterV1.ports` 只含与 capability 同名的 `"provider.health"` 和 `"work-item.read"`。runtime contract validator 使用 exact-key、显式 capability allowlist 和 capability/port 对账；出现 `append`、`apply`、`write`、未知 capability、重复 capability 或多余字段均拒绝。不提供可接收任意 capability 的通用 `invoke`；capability 也不从 HTTP method、函数名或 provider payload 推断。

## 配置

项目配置可选地包含：

```json
{
  "gitee": {
    "repository": "owner/repository"
  }
}
```

配置只接受一个 repository coordinate；`token`、`credential` 或其他多余字段失败关闭。repository 必须由两个安全 slug 组成，不接受空段、`.`、`..`、控制字符、query 或 URL。

当前仓库只有在操作者确认真实 TaskSeal Gitee repository 后才写入该坐标。公开 smoke 的 `oschina/git-osc` 是外部样本，不是项目集成坐标，因此使用临时配置或显式测试参数，不提交到 `config/project.json`。

## CLI

```text
taskseal inspect gitee-health

taskseal inspect gitee \
  --issue <case-sensitive-reference> \
  --work-item <id> \
  --criterion <key> \
  --snapshot-version 2 \
  --title-management provider|none
```

Gitee 只支持 schema version 2。缺少 `--snapshot-version 2`、缺少 title management、重复/未知参数或非法 Issue reference 返回退出码 2。配置、网络、scope 或 payload 错误返回退出码 1。成功返回裁剪 JSON，且不包含 raw response、header、整数 API id、Issue state、凭证、当前工作目录或本地绝对路径。

`gitee-health` 不隐式加入 `doctor`，避免本地诊断依赖公网。health 只返回 provider、ready 状态、规范化 repository scope 与检查时间。

## Transport 契约

Gitee client 只向固定 origin `https://gitee.com` 发起匿名 GET：

```text
GET /api/v5/repos/{owner}/{repository}
GET /api/v5/repos/{owner}/{repository}/issues/{number}
```

要求：

- `redirect = "error"`，请求有界 timeout；
- 不发送 Authorization，不接受 query token；
- 在 JSON parse 前按 UTF-8 字节数限制响应正文；可用时先检查 `Content-Length` 并流式累计；
- primitive、`null`、array、非法 JSON、超限正文和缺失字段全部拒绝；
- 401/403/404/429/其他 HTTP 错误映射为稳定错误码；
- transport、HTTP 与 payload 错误不回显响应正文、query、header、凭证或本地路径。

repository health 必须核对返回 `full_name`。Issue read 必须核对：

- 返回 repository `full_name` 与配置 scope 一致；
- 返回 `number` 与请求 reference 按大小写完全一致；
- title、created_at、updated_at 是有界有效值；
- `html_url` 使用 HTTPS、host 为 `gitee.com`、无 userinfo/port/query/fragment，path 精确匹配 repository 与 Issue reference。

repository slug 用规范化小写形成 scope identity；Issue reference 保留大小写。repository rename/move 被视为 mapping drift，不能自动合并旧身份。

## ProviderSnapshot v2

read-model `ProviderName` 扩展为 `github | linear | gitee`；这只表示 snapshot 可被读取和展示。import 层的 `ImportProvider` 继续只有 `github | linear`。

Gitee snapshot：

```text
schemaVersion = 2
mode = read-only
provider = gitee
scope.kind = repository
scope.key = gitee:repository:<canonical-owner>/<canonical-repository>
facts = [one issue fact]
```

对象身份使用 repository-scoped、区分大小写的 Issue reference：

```text
externalId = <canonical-owner>/<canonical-repository>#<number>
providerObjectKey = gitee:issue:<canonical-owner>/<canonical-repository>#<number>
```

响应整数 `id` 只用于 payload 合法性检查，不进入 snapshot 身份或输出。revision id 与 occurredAt 使用 `updated_at`；content digest 只覆盖裁剪后的 source object 与 observation。

candidate event 必须携带完整 rich ExternalLink：

- providerObjectKey、provider、objectType、externalId；
- repository scopeRef；
- 显式 managedFields；
- URL 与 lastObservation。

不得生成历史 `{ provider, externalId, url }` legacy candidate。Issue state 不映射为 TaskSeal WorkItem status。

## Issue #10 验收时的三重写入拒绝

> 后续状态：本节保留最小 read adapter 切片的历史验收边界。Issue `#34` 已按 [规格 0014](./0014-provider-ingress-gate.md) 增加 trusted registry、精确 per-scope ImportPolicy v2 与 Gitee `PolicyBinding v2`，因此当前 Gitee snapshot 可以受控 preview/apply；generic direct append 仍失败关闭。

### Snapshot preview

Issue `#10` 当时由 `ImportProvider` allowlist 返回 `SNAPSHOT_PROVIDER_NOT_IMPORTABLE`。当前只有 registry registration 与精确 Gitee scope policy 同时成立时才可生成计划；撤销任一条件都在写入前失败。

### Plan apply

Issue `#10` 当时无法生成合法 Gitee plan。当前 Gitee plan 使用 `PolicyBinding v2`，apply 会重验 registry/current policy，并逐项验证 action、rich link、URL 与 scope；伪造或跨 scope plan 仍以 `IMPORT_PLAN_TAMPERED` 零写入拒绝。

### Candidate direct append

当前 Domain 可 replay Provider-neutral rich link，但 live Gitee candidate 直接传给 `TaskSealService.append` 必须返回固定 `PROVIDER_INGRESS_FORBIDDEN`，并在 journal append 之前失败。candidate 不得被转换为 legacy link。

## 安全与兼容不变量

- manifest/read capability 不授予 import、apply、append 或外部写权限。
- 读取 snapshot 不实例化写入服务，不打开或修改 journal。
- 外部网络调用只有固定 origin 的匿名 GET。
- GitHub/Linear ProviderSnapshot v1/v2、import policy、legacy journal replay 与 receipt/digest 保持兼容。
- 不新增生产依赖，不提交凭证和开发者机器绝对路径。
- Gitee import 与通用 ingress gate 由 GitHub Issue `#34` 处理。

## 验收标准

1. manifest runtime contract 接受合法 Gitee adapter，并拒绝未知 capability、多余字段、重复声明、write/apply/append port 和 capability/port 不一致。
2. fake transport 覆盖 exact URL、GET、无认证、timeout、redirect、primitive/null/array、非法 JSON、oversize、HTTP 分类、scope drift、number case 和 URL drift。
3. normalizer 生成 repository-scoped identity、稳定 digest 与 rich candidate；不输出 API id、state 或 raw payload。
4. health、inspection 与 CLI 的成功/参数/安全错误均有自动化测试。
5. 在 Issue `#10` 基线中，preview、伪造 apply 与 direct append 三个入口全部零写入失败关闭；当前行为由规格 0014 的受控 import 测试接替。
6. 使用公开 `oschina/git-osc#I4` 完成匿名只读 smoke；运行前后项目 journal 不变，不保存 raw response。
7. 全量测试与 typecheck 通过；独立架构、安全和 diff 审查无剩余 P0–P3。

## 回滚

Issue `#10` 切片本身可删除 adapter、CLI 分支和 readable provider union 回滚；Issue `#34` 之后若已提交含 Gitee `PolicyBinding v2` 的 batch，则不能回滚到不识别 v2 的旧 reader。
