# 实验 0032：可安装 CLI 与版本化插件开发包

## 假设

在保持单 package、零生产依赖和 local-first 控制面的前提下，可以把源码 checkout
版 TaskSeal 转为可隔离安装的本地 tarball，并向外部开发者提供窄而明确的
Runner/Provider authoring SDK，而不开放任意第三方代码在控制进程内动态执行。

## 反证条件

- npm 安装后仍需执行 `.ts`、安装期编译或生产 TypeScript 依赖。
- tarball 携带源码、测试、本地配置、项目状态、开发者绝对路径或凭证。
- CLI help/version 需要项目配置、Hosted 服务或真实 Provider 凭证。
- public exports 可深入 application、domain、storage、journal、Acceptance 或 Host
  authority。
- plugin compatibility check 会加载 entrypoint，或会被 FIFO、超大文件和异常对象
  阻塞。
- Runner/Provider 示例只能依赖仓库内部相对路径，不能从安装包公开入口通过合同。
- Windows 与 POSIX npm bin、最低 Node 和当前 Node 无法进入自动门禁。

## 基线证据

实施前，`npm pack --dry-run --json` 包含 296 个条目、解包约 3.59 MiB；bin 指向
`src/cli.ts`。在干净目录安装 tarball 后，Node.js 24 因拒绝执行 `node_modules`
下的 TypeScript type stripping 而返回
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。这证明“仓库源码可运行”不能代替
“安装包可运行”。

## 实施

1. 使用独立 `tsconfig.build.json` 把 `src/` 编译为 `dist/` ESM JavaScript 和
   declarations；相对 `.ts` import 在 emit 时改写，CLI shebang 保留。
2. npm bin 指向 `dist/bin/taskseal.js`；启动器在导入完整 CLI 前检查
   `>=24.12.0 <25`，源码 checkout scripts 保持不变。
3. `files` 只允许 `dist/public/fixtures/schemas/examples/README`，`exports` 只开放
   版本化 Runner、Provider、Plugin、contract kit 与 schema 子路径。
4. Plugin Manifest v1 使用 exact plain-object decoder；静态命令只读取 64 KiB
   有界 JSON，不解析或执行 entrypoint。
5. 文件以平台可用的 `O_NONBLOCK/O_NOFOLLOW` 打开并对已打开 handle 做 `fstat`；
   POSIX FIFO、symlink 和其他非普通文件失败关闭。
6. entrypoint 拒绝 traversal、反斜杠、非 JavaScript 扩展、Windows device name
   与尾点路径；schema 与 runtime 共用相同兼容样例。
7. Runner/Provider facade 复用核心既有 decoder/normalizer；公开 test kit 使用
   `node:test`，示例不读取环境凭证。
8. package smoke 真实执行 pack、隔离 install、npm bin、SDK/runtime import、
   外部 TypeScript consumer、内部路径拒绝、schema import 与两个示例合同。

## 验证结果

- Windows 本机：Node.js `24.15.0`、npm `11.12.1`。
- `npm test`：
  - TypeScript typecheck 和 `tsc → dist` 通过；
  - 主测试 `890` 项，`889` 通过、`0` 失败、`1` 项 POSIX FIFO 测试在 Windows
    按平台跳过；
  - 隔离 package smoke `1/1` 通过。
- `npm pack --dry-run --json`：`170` 个条目；只有声明根目录，原始 `.ts` 为 0，
  production dependencies 为 0。
- 安装态验证：
  - Windows npm bin help/version/plugin check 通过；
  - Node 25 模拟在加载完整 CLI 前返回稳定 `TASKSEAL_NODE_UNSUPPORTED`；
  - 五个 public SDK/testing 子入口和两个 JSON schema 可导入；
  - 深入 `dist/application` 返回 `ERR_PACKAGE_PATH_NOT_EXPORTED`；
  - 仓库外 strict TypeScript consumer 编译通过；
  - Echo Runner 三项合同与 Memory Provider 两项合同全部通过。
- 发布物扫描未发现开发者绝对路径或常见 GitHub、Linear、OpenAI token 形状；
  安装 manifest 明确不存在 `preinstall/install/postinstall/prepare`。
- 两路独立架构/安全审查最终均无剩余 P0/P1/P2。
- Ubuntu 的 Node `24.12.0` 与 `24.x` matrix 会实际执行 POSIX FIFO、bin 和全部
  package smoke，并由稳定的聚合 `tests` Check 承载合并门禁。

## 结论

技术假设成立。TaskSeal 已从“只能在源码仓库运行”推进到“可以生成可审计、可隔离
安装、可供仓库外开发者编译和测试的本地 CLI/SDK artifact”，同时没有把静态
manifest 误宣称为第三方插件运行时。

## 已知边界

- package 仍为 `private` experiment，只验证本地 tarball，不发布 npm registry。
- Provider SDK 是可信开发者的只读 authoring contract，不是通用动态 Provider ABI。
- Plugin Manifest entrypoint 当前只是审计坐标；没有发现、安装、签名、加载或沙箱。
- 第三方 Runner 真正运行前仍需单独设计有界子进程 wire protocol；普通子进程也
  不是安全沙箱。
- Node 25 和其他 major 未验证，因此首版显式拒绝。
- 远程团队、认证、RBAC、租户、数据库与队列继续由真实试点触发，不因可安装 CLI
  提前引入 NestJS 或 monorepo。
