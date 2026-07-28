# 规格 0024：可安装 CLI 与插件开发包

## 背景与问题

TaskSeal 当前 `bin` 指向 `src/cli.ts`。源码 checkout 可以依赖 Node.js 的原生
TypeScript type stripping，但 Node.js 明确拒绝执行 `node_modules` 下的 TypeScript；
因此 tarball 可以被 npm 安装，生成的 `.bin/taskseal` 却无法运行。当前 pack 还会
携带整个源码、测试、仓库配置和项目文档，不能作为受控发布物。

NP-8 已形成稳定 Runner v1 合同，Provider 也已有只读 Adapter v1。NP-10 要把这些
已验证接缝交付为 CLI-first 的安装包和开发包，但不开放未经信任代码在 TaskSeal
控制进程内动态执行。

## 目标与成功指标

- 从干净目录安装本地 tarball 后，Windows/POSIX npm bin 能运行标准 help/version。
- 安装包只包含编译后的 JavaScript、声明文件、Control Room 静态资源、schema、
  示例插件、README 和 package manifest。
- 通过显式版本化 exports 提供 Runner、Provider、Plugin manifest 与 contract test
  kit。
- 不兼容、畸形或越界的 plugin manifest 在执行任何插件代码前失败关闭并返回稳定
  诊断。
- 示例 Runner 与 Provider 插件直接针对安装后的 package exports 通过 contract。
- 最低 Node.js 24.12 与当前 Node.js 24 都进入 CI 门禁。
- 核心运行和 SDK 均不依赖 hosted TaskSeal 服务，也不新增生产依赖。

## 范围内

- `tsc → dist` ESM JavaScript 与 `.d.ts`。
- npm `files`、`bin`、`exports`、`types`、`engines` 与 `prepack` 门禁。
- 标准 `taskseal --help`、`taskseal --version`。
- `taskseal plugin check <manifest.json>` 静态兼容检查。
- Plugin Manifest v1、Runner/Provider SDK facade、公开 contract test kit。
- project config 与 plugin manifest JSON Schema。
- 一个 Runner 示例插件和一个只读 Provider 示例插件。
- tarball 内容审计、隔离 install/bin/import/example smoke 与 Node matrix。

## 范围外

- `npm publish`、取消 `private: true` 或声明公开稳定版。
- 下载、发现、安装、签名、启用或动态执行第三方插件。
- 将 journal、Host authority、控制面凭证或 Acceptance API 暴露给插件。
- monorepo、NestJS、浏览器 bundle、远程 daemon、hosted Control Room。
- Provider 写能力、插件市场、计费、租户与远程沙箱。
- 支持 Node.js 24.12 以下版本。

## 用户或系统场景

### 安装并运行

Given 一个不包含 TaskSeal 源码的干净项目
When 安装由当前提交生成的 tarball 并运行 npm bin 的 `taskseal --help`
Then 进程以 0 退出、输出稳定 Usage，且运行时不读取 `.ts` 或需要 TypeScript。

### 使用 SDK

Given tarball 已安装
When ESM 消费者导入 `taskseal/runner/v1`、`taskseal/provider/v1` 和
`taskseal/plugin/v1`
Then 只能解析到声明的 exports，并可获得 v1 types、runtime decoders 与版本常量。

### 检查兼容性

Given 一个 plain JSON plugin manifest
When 运行 `taskseal plugin check`
Then 只读取有界 JSON、从不 import `entrypoint`，并输出规范化 manifest。

Given manifest 的 plugin API、Runner/Provider contract 或最低 Node 版本不受支持
When 检查该 manifest
Then 以 1 退出并只输出稳定错误码/摘要，不输出文件正文、异常 cause 或凭证。

### 验证示例插件

Given 示例 Runner/Provider 位于安装包中
When 在干净项目中运行公开 contract test kit
Then manifest、输出绑定、取消 settle 和只读 Provider ports 均通过。

## 功能需求

### 发布物

1. `dist/` 由 strict TypeScript 配置生成，保留目录结构与 CLI shebang，并把相对
   `.ts` import 改写为 `.js`。
2. npm package 使用 allowlist；只包含 `dist/`、`public/`、运行 demo 所需的
   `fixtures/`、`schemas/`、`examples/`、README 与 manifest；不得包含 `src/`、
   `test/`、`test-support/`、`.taskseal/`、开发者配置、凭证或本地绝对路径。
3. tarball 安装阶段没有 build/install/postinstall script；编译只发生在 pack 前。
4. package 保持零 production dependencies 与 `private: true`。

### 公共 SDK

1. package exports 只开放显式版本化 facade，不允许通过 exports 深入内部
   application/domain/storage 模块；首版不提供容易形成模糊兼容承诺的根导出。
2. `taskseal/runner/v1` 复用现有 `DigitalEmployeeAdapter`、
   manifest/input/output decoder，不复制第二份合同。
3. `taskseal/provider/v1` 复用现有只读 `ProviderAdapterV1` 和 normalizer；它是
   操作者信任的 authoring contract，不是任意 Provider 的动态运行 ABI。
4. test kit 使用 Node 内置 `node:test`，不引入测试框架依赖。
5. package version 与 Plugin/Runner/Provider API version 独立；兼容性由显式 API
   version 判断，不由模糊 package semver 推断。

### Plugin Manifest v1

Manifest 是 exact plain object：

```text
schemaVersion    = 1
apiVersion       = taskseal.plugin/v1
pluginId         = bounded lowercase identifier
pluginVersion    = exact semantic version
pluginType       = runner | provider
contractVersion  = taskseal.runner/v1 | taskseal.provider/v1
minimumNodeVersion = semantic version
entrypoint       = safe ./ relative .js path
```

- `pluginType` 与 `contractVersion` 必须匹配。
- `minimumNodeVersion` 不得低于 TaskSeal 自身最低版本，也不得高于当前 Host 版本。
- parser 拒绝未知字段、accessor、symbol、自定义 prototype、路径穿越和非规范版本。
- `entrypoint` 只是审计坐标；本里程碑不读取或执行它。

### 配置 schema

- `schemas/project-config.schema.json` 描述本地项目配置的公开 authoring shape。
- `schemas/plugin-manifest.schema.json` 与 Plugin Manifest v1 parser 保持一致。
- 两个 schema 均随 tarball 发布并通过 package subpath export 可定位。
- schema 不包含任何真实项目坐标、Token 或开发者路径。

## 业务规则与不变量

1. package exports 是公共 API allowlist；未导出的内部路径不构成兼容承诺。
2. plugin capability/manifest 只声明能力，不能授予 workspace、Provider 或控制面权限。
3. Runner handoff 仍是不可信 claim，不能直接生成 Artifact/Evidence/Acceptance。
4. Provider SDK 首版只支持既有 `provider.health` 与 `work-item.read`。
5. 静态 plugin 检查不得执行插件代码或 package lifecycle script。
6. source-checkout scripts 保持可用；安装路径与 checkout 路径共享同一 CLI 实现。

## 数据、接口与状态变化

- 不修改 WorkItem、Attempt、Artifact、Evidence、Acceptance 或 journal schema。
- 新增的 Plugin Manifest 不写入 TaskSeal 状态；CLI 只返回一次性诊断。
- `dist/` 是临时构建产物并被 Git 忽略，不作为源码提交。
- npm tarball 是验证产物，不上传 registry。

## 错误与边界情况

- 文件缺失、非普通文件、超过 64 KiB、无效 UTF-8/JSON：`PLUGIN_MANIFEST_INVALID`。
- plugin API 不支持：`PLUGIN_API_UNSUPPORTED`。
- plugin type/contract 不匹配或合同版本未知：`PLUGIN_CONTRACT_UNSUPPORTED`。
- Node 最低版本不兼容：`PLUGIN_NODE_UNSUPPORTED`。
- CLI 参数错误返回 2 与 Usage；已解析但不兼容返回 1 与稳定诊断。
- pack/install 或 example contract 失败必须阻止交付。

## 权限、安全、隐私与审计影响

- manifest check 只读、无网络、无动态 import、无 shell 拼接。
- tarball allowlist 和凭证/绝对路径扫描是发布门禁。
- 示例插件不得读取环境凭证；Provider 示例只使用确定性内存数据。
- SDK 不导出 journal append、Acceptance、Linear/GitHub transport 或 Host policy
  注入点。

## 兼容、迁移与回退

- package 仍为同一个 `taskseal` 单包；CLI、SDK 和静态资源同版本发布。ADR 0002
  的 monorepo 触发条件已经重新评估，但当前没有独立版本、部署或所有权边界，因此
  暂不拆包。
- source checkout 的 `npm start` / `npm run taskseal` 保持直接运行 TypeScript；
  只有 npm bin 指向 `dist/bin/taskseal.js`。
- Plugin/Runner/Provider v1 一旦公开，只能兼容扩展或以新 namespaced version 演进。
- 若安装包门禁失败，保持 `private: true`，回退 `bin/exports/files/prepack` 即可；
  不涉及状态或数据迁移。

## 可观测性与运维要求

- `--version` 输出 package version，plugin check 输出 normalized version facts。
- package smoke 记录 entry count、禁止路径、bin/import/contract 结果。
- CI 清楚区分最低 Node 24.12 与当前 Node 24；首版 engine 上限固定 `<25`，不把
  未验证的新 major 当成已支持。

## 验收标准

1. 现有源码 tarball 的 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` 回归先失败，
   改为 dist bin 后隔离安装真实运行通过。
2. pack allowlist 不包含源码、测试、本地状态、项目配置或未声明文件。
3. `--help`、`--version`、SDK imports 与 schema subpaths 在安装后通过。
4. 兼容 Runner/Provider 示例 manifest 通过；unsupported API/contract/Node、路径
   穿越和未知字段稳定失败关闭且 entrypoint 零执行。
5. Runner 与 Provider public contract kit 在安装包自身示例上通过。
6. checkout CLI 与既有全量测试无回归。
7. Node 24.12 与当前 Node 24 CI 均通过 build、test、pack/install smoke。
8. 独立架构与安全审查确认 exports、权限、凭证和动态执行边界。

## 未决问题

无阻塞问题。是否公开发布 registry、是否拆 monorepo、以及第三方进程协议的真正
加载/沙箱机制，需要安装包被仓库外试用后另立规格。

## 参考

- Node.js TypeScript：<https://nodejs.org/api/typescript.html>
- npm package manifest：<https://docs.npmjs.com/cli/configuring-npm/package-json/>
- npm package 内容控制：<https://docs.npmjs.com/cli/using-npm/developers/>
- TypeScript `rewriteRelativeImportExtensions`：
  <https://www.typescriptlang.org/tsconfig/rewriteRelativeImportExtensions.html>
