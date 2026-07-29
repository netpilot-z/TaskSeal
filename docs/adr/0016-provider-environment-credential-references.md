# ADR 0016：Provider v1 环境凭证引用

## 状态

已接受。

## 背景

Gitee Adapter 证明了无凭证 Provider 可以使用 `taskseal.provider/v1` 的
`provider.health` 与 `work-item.read` 端口，但其 manifest 把 credential
收窄为固定的 `{ "mode": "none" }`。飞书只读 Adapter 必须用 App ID/Secret
换取短期 `tenant_access_token`，真实值又不能进入 manifest、项目配置、
snapshot、日志或插件合同。

AdapterManifest v1 的原始设计已经包含“credential reference mode”，只是首个
Gitee 实现没有证明第二种模式。现有公共 port、capability、scope 与配置字段结构
不需要改变。

## 决策

对 `taskseal.provider/v1` 做向后兼容扩展：

- 保留 `{ "mode": "none" }` 的原有字节与行为。
- 新增 `{ "mode": "environment", "references": [...] }`。
- 每个引用只包含稳定语义 key、环境变量名称与固定 `secret: true`。
- 引用列表有界，key 与环境变量名称分别唯一。
- 环境变量名只接受规范的大写标识；unknown field、真实 value、accessor、
  非 plain object 和 `secret: false` 全部失败关闭。
- normalizer 只验证并复制引用，不读取环境变量值。
- 凭证解析、缺失诊断、token 获取与缓存仍由受信任 Host/Adapter composition
  负责，不进入公共 manifest decoder。

该扩展不新增 port、不授予写能力，也不改变 `apiVersion`。旧 v1 consumer 和
Gitee manifest 保持兼容；新 consumer 只依赖 v1 原本承诺的 credential reference
概念。

## 选择理由

- 最小变化直接补齐已经预留但未实现的 v1 reference mode。
- manifest 可以被审计，却永远不携带凭证值。
- Provider SDK 不需要导出环境读取、secret store 或控制面权限。
- 飞书的短期 token 生命周期可保持在 Adapter 私有边界。

## 被拒绝方案

### 把 App ID/Secret 当作 configuration field

会让 authoring 配置与 secret value 混合，并可能把真实值带入配置、诊断和
snapshot，不采用。

### 直接建立 `taskseal.provider/v2`

如果必须改变 port、capability 或 Host ABI，v2 才是正确选择。本次只补齐 v1
已经声明的 credential reference mode，建立新版本会同时扩大 Plugin Manifest、
exports、示例与兼容矩阵，没有相应收益。

### Adapter 自行读取任意环境变量

无法静态审计所需凭证，也会让未知环境 key 进入 Provider 边界，不采用。

## 安全与兼容影响

- manifest、normalizer 返回值与 contract test 不包含 secret value。
- 环境引用只声明需求，不代表 Host 已授权或已提供真实值。
- Runner 的环境 allowlist 不受影响；Provider 凭证不得转交给数字员工进程。
- 回退只需拒绝 `environment` mode；既有 `none` manifest 和 journal 无需迁移。
