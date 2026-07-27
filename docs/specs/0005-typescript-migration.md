# 规格 0005：渐进式 TypeScript 迁移

## 背景与问题

TaskSeal 已经包含领域状态机、文件 journal、Codex runner、provider 适配器、CLI 和本地 HTTP 服务。这些模块通过 JavaScript 运行时测试保护行为，但跨模块对象、错误码、事件 payload 和依赖注入接口缺少提交前类型检查。

一次性重写全部源码会同时改变大量 import、测试和入口，难以复核。当前也没有独立部署、npm 发布或远程后端需求，不能用未来假设证明 NestJS 或 monorepo 的即时成本。

## 目标与成功指标

- 服务端代码和测试按可审查切片从 `.js` 迁移到 `.ts`。
- 每次 `npm test` 先执行 strict TypeScript 检查，再执行完整行为测试。
- 直接运行源码，不生成或提交 `dist/`。
- 生产依赖保持为零。
- 现有 CLI、HTTP、provider、runner 和领域行为不变。
- 每个迁移切片都可以独立回退，不阻塞其他功能分支。

## 范围内

- TypeScript compiler 和 Node.js 类型声明作为开发依赖。
- Node.js 最低版本提升到 24.12。
- `doctor` 按完整版本拒绝低于 24.12 的运行时。
- strict、no-emit、erasable-only 的 TypeScript 配置。
- Node.js 服务端源码、测试和 test-support 的渐进迁移。
- 第一切片迁移项目配置读取/校验及其测试。
- CI 安装锁定的开发依赖，并执行统一测试门禁。
- TypeScript、NestJS 和 monorepo 的后续升级条件。

## 范围外

- 当前引入 NestJS、Express、Fastify 或其他生产依赖。
- 当前启用 npm workspaces、拆包或独立版本发布。
- 把 `public/` 浏览器脚本迁移为 TypeScript。
- 建立 bundler、transpiler、`dist/` 或容器发布链。
- 改写领域规则、provider 契约或外部系统权限。
- 将本里程碑 tickets 自动同步到 GitHub 或 Linear。

## 运行与类型契约

1. 生产和测试使用 Node.js 24.12 以上版本直接执行 `.ts`。
2. `tsc --noEmit` 是类型门禁，Node.js 仍负责运行；两者职责不能混淆。
3. `.ts` 文件的相对 import 必须带 `.ts` 扩展。
4. 只用于类型的符号必须通过 `import type` 导入。
5. 禁止 enum、parameter properties、namespace runtime 等需要转换的 TypeScript 语法。
6. 禁止为了 import 便利增加 path alias；运行时可解析性优先。
7. 外部输入先视为 `unknown`，经过运行时校验后才能进入已知类型。
8. 类型应靠近其所有者；只有被多个稳定模块复用的契约才提取到共享文件。
9. 迁移期间 JavaScript 可以显式导入 `.ts`；未迁移 JavaScript 不进入 strict 检查。
10. 不能通过 `any`、宽泛类型断言或跳过检查制造绿色结果。

## 第一切片

`src/config/project-config.ts` 是第一条垂直切片：

- 输入是文件系统读取的未知 JSON；
- 输出被 CLI、provider inspection 和 Linear dry-run 使用；
- 错误码是可观察契约；
- 同时验证 JavaScript 消费 TypeScript、`.test.ts` 发现和完整回归。

该切片不得改变合法配置的输出，也不得弱化 GitHub `owner/name`、Linear workspace/team 或错误码校验。

## 迁移顺序

1. 类型门禁、锁文件、CI 和项目配置切片；
2. domain workflow 与 dashboard projection；
3. application service 与 file journal；
4. provider normalizer/read client；
5. snapshot importer 与测试 fixture；
6. Codex runner 与 App Server transport；
7. CLI 和 HTTP server；
8. 单独决定 Control Room 的前端工具链。

每一步只迁移一组具有共同契约的文件，不做全仓库扩展名批量替换。

## 兼容、回退与分支协作

- `bin` 继续指向 JavaScript CLI，直到 CLI 切片迁移。
- 静态资源目录和 URL 不变。
- 迁移分支不混入 snapshot import 或外部 provider 写入功能。
- 任一切片失败时，可把该切片恢复为 `.js` 并删除对应类型，不影响其他已迁移模块。
- 如果 Node 原生执行出现无法接受的调试、工具或发布问题，创建新 ADR 切换为 `tsc → dist`，不得在单个模块中私自加入 loader。

## 验收标准

1. `npm ci` 可从锁文件安装开发工具。
2. `npm run typecheck` 在不生成 JavaScript 的情况下通过。
3. `npm test` 执行类型门禁并保持全部既有测试通过。
4. Node test runner 能发现并运行 `.test.ts`。
5. JavaScript 应用模块能直接导入并调用 `.ts` 配置模块。
6. 无 enum、parameter property、path alias、生产依赖或 `dist/`。
7. CI 使用 Node.js 24，并在测试前安装锁定依赖。
8. 仓库不包含本地绝对路径、凭证或生成的 JavaScript。
9. `doctor` 对 Node.js 24.11 返回未就绪，对 24.12 返回就绪。

## 后续决策门槛

NestJS、monorepo 和编译产物的触发条件以 ADR 0002 为准。未满足门槛前，新增模块继续遵守当前单 package 和 framework-free core 结构。

## 未决问题

无阻塞问题。npm CLI 发布、远程多人后端和独立 Web 构建均在真实需求出现后另行规格化。
