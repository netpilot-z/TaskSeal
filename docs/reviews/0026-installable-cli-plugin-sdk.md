# 审查 0026：可安装 CLI 与版本化插件开发包

## 范围

本次审查覆盖 Linear `NP-10`：

- `tsc → dist`、npm bin、files/exports、engine 与 CI matrix；
- 标准 help/version 和静态 `plugin check`；
- Plugin Manifest v1 parser、schema、文件读取与安全诊断；
- Runner/Provider facade、公开 contract kit 与示例；
- tarball 内容、安装期脚本、隔离 install、外部 JS/TypeScript consumer；
- 单 package、monorepo/NestJS 触发条件和未来第三方运行边界。

## 独立审查发现

首轮架构与发布安全审查发现：

1. package 额外导出 `./package.json`，超过最小公共面且没有外部用例；
2. `open(path, "r")` 在 POSIX FIFO 上会先于 `fstat` 永久等待 writer；
3. entrypoint 接受 `con.js`、`aux/index.js` 和尾点目录，Windows 无法可靠解析；
4. plugin schema 接受低于 TaskSeal 基线的 Node 版本，但 runtime 固定拒绝；
5. 凭证扫描正则没有覆盖真实 `ghp_`、`github_pat_` 与 `lin_api_` 前缀；
6. 安装 smoke 使用 `--ignore-scripts`，却没有证明 tarball manifest 不含安装期
   lifecycle script；
7. plugin minimum 最初只要求当前 Node 满足它，没有要求其不低于 TaskSeal 自身
   `24.12.0` 基线。

## 修复与复审

- 删除未使用的 `./package.json` export；公共面只保留版本化 facade、test kit 和
  schema。
- 以平台可用的 `O_NONBLOCK/O_NOFOLLOW` 打开文件，再对同一 handle 做 bounded
  read 与 `fstat().isFile()`；新增 POSIX FIFO 子进程超时回归。
- parser/schema 同步拒绝 Windows device name、尾点、traversal、反斜杠和非 JS
  entrypoint。
- runtime 同时校验 Host、Plugin 与 TaskSeal minimum；schema 编码 API v1 的
  `24.12.0` 下界，并用同表样例验证。
- package gate 使用真实 GitHub/Linear/OpenAI token 前缀 sentinel，并扫描每个
  安装文件。
- 保留 `--ignore-scripts` 的安全安装方式，同时显式断言不存在
  `preinstall/install/postinstall/prepare`。
- CI matrix 增加 Node `24.12.0` 与 `24.x`，另设稳定 `tests` 聚合 Check，避免
  破坏既有 PR/branch protection 名称。

复审后没有剩余或新增 P0/P1/P2；单 package 决策、依赖方向、Provider 只读
authoring 边界和未来 subprocess 迁移路径均可接受。

## 验证证据

- `npm test`：主测试 `890` 项，`889` 通过、`0` 失败、Windows 平台跳过
  `1` 项 POSIX FIFO；随后 package smoke `1/1` 通过。
- `npm run typecheck` 与 `npm run build` 通过。
- 独立安全定向复核 `13` 项：`12` 通过、Windows 按预期跳过 POSIX FIFO `1` 项。
- pack 为 `170` 个 allowlisted 条目，raw TypeScript、项目配置、测试、文档和
  production dependencies 均未进入 tarball。
- 隔离 install 验证 Windows npm bin、SDK imports、schema imports、外部
  TypeScript consumer、内部 export fence、Node 25 fail-fast 和五个 example
  contracts。
- `git diff --check` 无 whitespace error；只有 Git 的工作区 LF/CRLF 提示。
- 仓库和发布物扫描未发现开发者机器绝对路径或凭证形状。

## 风险与限制

- 本审查只批准静态 manifest 与 authoring SDK，不批准任意第三方插件在 TaskSeal
  进程内执行。
- 真实 Runner 插件需要单独的 subprocess wire contract、环境 allowlist、
  stdout/stderr/timeout/cleanup bounds 和实现 revision；不能直接动态 import。
- Provider 的泛型请求/结果不是 wire codec，现有闭集 Provider ingress 也不会因
  SDK export 自动扩张。
- npm registry、许可证、公开 package 名称和稳定 semver 仍未决；保持
  `private: true`。
- Windows 本机无法执行 FIFO 回归；该项由 Ubuntu CI matrix 提供真实证据。

## 结论

NP-10 满足技术验证合同，可以进入 PR 与 CI 门禁。TaskSeal 现在具备真实可安装的
compiled CLI、受控发布物和可供外部开发者使用的版本化 SDK；所有第三方运行权限仍
留在后续明确规格中。
