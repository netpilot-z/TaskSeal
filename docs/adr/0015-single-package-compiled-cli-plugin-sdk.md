# ADR 0015：单包编译 CLI 与窄插件 SDK

## 状态

已接受。

## 背景

ADR 0002 选择源码 checkout 的 Node.js TypeScript 运行路径，并把“发布 npm
CLI/SDK”列为重新评估编译产物的触发条件。该条件现已由 NP-10 满足：真实 tarball
安装后，Node.js 因拒绝 `node_modules` 下的 TypeScript type stripping 而无法执行
现有 bin；同时外部 Runner/Provider 开发者需要可导入的声明和 contract kit。

现阶段 CLI、Control Room、Runner/Provider contracts 仍由同一仓库、同一版本、
同一测试门禁交付。尚未出现独立部署、独立版本或独立团队所有权。

## 决策

### 1. 使用单 package 的 `tsc → dist`

- 保留现有 `src/` 作为唯一 TypeScript 源码。
- 增加只用于发布的 build config，输出 ESM JavaScript 与 declarations 到 `dist/`。
- npm bin 指向 `dist/bin/taskseal.js`；checkout scripts 继续直接运行
  `src/cli.ts`。
- pack 前重建 `dist/`，tarball 安装时不运行任何 build/install script。

### 2. 用 `files` 与 `exports` 双 allowlist

- `files` 只包含 dist、public、demo fixtures、schemas、examples 和 README。
- `exports` 只开放 SDK facade、Runner/Provider/Plugin 子入口、contract test kit 和
  schema 坐标。
- application、domain、storage、transport 与 composition root 保持私有。

### 3. 兼容性绑定 namespaced API，不绑定 package semver

Plugin Manifest v1 明确声明：

- `taskseal.plugin/v1`；
- `taskseal.runner/v1` 或 `taskseal.provider/v1`；
- plugin 自身 semantic version；
- 最低 Node.js 版本。

Host exact decode 后才报告兼容；package 版本只用于发布身份，不推断插件能力。

### 4. 首版只做静态 manifest 检查

`taskseal plugin check` 只读取有界 JSON，不 import entrypoint。插件 contract test
由开发者或 CI 在独立测试进程中显式导入插件。TaskSeal 核心不动态执行未经信任的
in-process 代码，也不把凭证、journal authority 或 Host policy 下放给插件。

### 5. 暂不拆 monorepo

CLI 与 SDK 当前必须同版本发布，且公共 facade 只是同包 subpath export。没有独立
版本、依赖或部署边界，因此 monorepo 会引入额外 package graph、release 和 lockfile
复杂度而没有隔离收益。出现独立发布或所有权后再执行 ADR 0002 的目录迁移。

## 选择理由

- 编译 JS 是解决安装失败的直接必要条件；不增加 production runtime。
- allowlist 比维护排除列表更容易证明 tarball 不含项目状态和未声明源码。
- 复用现有 runtime decoder，避免 SDK 与核心合同漂移。
- 静态检查先解决版本诊断与开发体验，同时保留未来进程隔离协议的安全空间。
- 单包仍能提供多个清晰 public subpath，且回退不涉及数据迁移。

## 被拒绝方案

### 继续发布 `.ts`

Node.js 官方行为会在 `node_modules` 下固定拒绝 type stripping；安装成功不等于 bin
可运行，因此不可采用。

### 运行时依赖 `tsx` 或 TypeScript

会新增生产依赖、安装脚本和版本耦合，只为绕过可以在 pack 时完成的编译，不采用。

### 单文件 bundle

能减少文件数，但需要新增 bundler、处理动态资源路径与 source map，并可能隐藏
模块边界。当前零生产依赖的 `tsc` 已足够。

### 立即拆 monorepo

尚无独立发布边界；会扩大 lockfile、CI、版本和 import 迁移范围，不采用。

### 动态 import 任意第三方插件

同进程插件可以读取环境、文件和控制面内存，无法兑现凭证隔离。加载、签名和沙箱
必须作为独立进程协议另行设计。

### 取消 `private: true` 并直接发布

当前目标是验证可安装 artifact，不是对公共 registry 作出稳定性承诺。保持 private
可防止误发布。

## 影响

正面：

- Windows/POSIX 干净安装获得真实可运行 bin。
- SDK consumers 获得明确 types/runtime decoder/test kit，而不是内部深层 import。
- tarball 内容和公共 API 都可自动审计。
- 核心继续 local-first、零 production dependencies、无 hosted 服务要求。

限制：

- 仍没有第三方插件安装/启用/runtime sandbox。
- Plugin Manifest v1 的 entrypoint 只是坐标。
- project config schema 是 authoring contract；具体命令仍会执行更窄的运行时校验。
- package 仍为 experiment/private，不能直接 `npm publish`。

## 回退

删除 dist build/exports/files/plugin CLI 与 examples，并把 bin 恢复为 source checkout
入口即可。Workflow、Provider、Decomposition 和其他 journal 均无 schema 变化，
无需迁移或数据回滚。
