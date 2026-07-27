# 实验 0012：CLI 与源码 Bin TypeScript 迁移

## 实验卡

- 决策：能否在不建立编译产物、不新增生产依赖的前提下，把 CLI、命令测试和 private/source-checkout 入口迁移到 strict TypeScript。
- 假设：命令参数、依赖注入结果、进程退出码、信号与 shutdown 能用窄 port 和运行时 guard 表达；Windows 可通过 Node/npm scripts 运行，POSIX 源码入口可保持 shebang、LF 与 executable mode。
- 反证：必须使用 `any`、类型断言或类型忽略；命令行为或退出码回归；源码入口失去 shebang/可执行位；把无法从 `node_modules` 原生执行的 `.ts` 错当成可安装 npm CLI。
- 指标：strict 类型检查、CLI 定向与全量测试通过；Windows 入口 smoke、POSIX 文件契约、pack 内容和独立审查通过；生产依赖保持为零。
- 边界：迁移 CLI 和三个直接测试，更新 private package 的 bin/start/taskseal 元数据；可分发 JavaScript CLI 另由 GitHub Issue `#32` 跟踪。

## Red

机械改名后 `npm run typecheck` 产生 162 条诊断，集中在六类接缝：

1. CLI 依赖注入函数与返回值原先隐式为 `any`；
2. 参数 parser 在 `noUncheckedIndexedAccess` 下可能读取缺失值；
3. command runner、Codex 探测和 JSON 输出跨越不可信边界；
4. service、runner、HTTP server 与 signal source 使用宽泛 duck type；
5. caught error、shutdown 与 child process exit code 缺少收窄；
6. 测试假体、事件数组和 JSON parse 结果缺少明确类型。

入口契约另有两个红灯：

- package metadata 与测试仍指向已迁移的 `src/cli.js`；
- Windows working copy 会把 CLI 转成 CRLF，破坏 POSIX shebang 的直接执行语义。

## Green

- `runCli` 使用明确的 exit code、output、command runner、inspect、sync、run 与 start ports。
- 注入的 command/runner 结果先作为 `unknown`，再校验整数退出码、stdout/stderr、Attempt ID、terminal outcome 与可选文本。
- 参数 parser 只从完整的 named-argument map 读取值；无效或不兼容参数继续返回 usage 与 exit 2。
- Codex 可执行文件解析、版本选择、doctor、init、run、inspect、sync 和 start 行为保持。
- signal source 使用窄适配器，shutdown 同时覆盖扩展 `shutdown()` 与 Node `close(callback)`。
- child process 继续使用参数数组、`shell: false` 和 `windowsHide: true`。
- `package.json`、lockfile 与 npm scripts 指向 `src/cli.ts`；`.gitattributes` 固定 CLI 为 LF，Git mode 保持 `100755`。
- README 的全部当前命令示例同步为 `.ts`，历史 runner ticket 标注迁移后的验证入口。

## 发布边界

当前包仍为 `private: true`。Node 原生 TypeScript 不对 `node_modules` 内的 `.ts` 执行 type stripping，因此本切片只证明源码 checkout 的入口，不证明 npm tarball 可安装。

`npm pack --dry-run --json` 用于审计内容：预览中包含 `src/cli.ts`、不包含 `src/cli.js`；Windows 生成的 pack metadata 将文件报告为 `0644`。该结果被记录为发布边界，而不是伪装成跨平台安装成功。真正的 `tsc → dist`、bundle 或插件包装、隔离 tarball install 与 Windows/Ubuntu `.bin` smoke 由 Issue `#32` 决策和验证。

## 验证证据

- `npm run typecheck`：通过，162 条诊断收敛为 0。
- CLI/doctor/inspect/sync/run 定向测试：25/25 通过。
- `npm test`：249/249 通过，0 fail、0 skipped、0 todo。
- Windows：直接 `node src/cli.ts unknown` 与 npm script 均返回 exit 2 和 Usage；两种 Linear dry-run 均返回 exit 0、`networkRequests: 0`、`externalWrites: 0`、`mutationReady: false`。
- POSIX 源码文件契约：shebang 正确、CRLF 为 0、文件以 LF 结尾、Git mode 为 `100755`。
- `npm pack --dry-run --json`：通过；包含一个 `src/cli.ts`，不包含 `src/cli.js`，没有生成 tarball。
- `git diff --check`：通过。
- 目标 TypeScript 文件中 `any`、类型断言、类型忽略、测试 skip/only、本地绝对路径和凭证扫描均为 0。
- 生产依赖 0，开发依赖维持 2。

## 剩余风险

- 本地 Windows 没有直接执行 POSIX shebang；已增加非 Windows raw-entry 进程测试，必须由 Ubuntu CI 实际通过后才能合并。
- `bin: src/cli.ts` 只服务 private/source checkout，不支持安装到 `node_modules` 后执行；仓库外分发必须完成 Issue `#32`。
- Control Room 仍是 loopback 单进程原型；本切片没有增加认证、远程 daemon 或多租户能力。

## 结论

本地证据支持 private/source-checkout 假设。计划内 Node.js 服务端源码已进入 strict TypeScript，Windows 本地入口与 POSIX 源码文件契约可复核；Ubuntu raw-entry 进程测试仍是合并门禁。可安装 CLI 被明确隔离为后续发布切片，没有把 pack 预览误报为分发能力。
