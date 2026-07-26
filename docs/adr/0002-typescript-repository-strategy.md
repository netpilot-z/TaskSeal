# ADR 0002：TypeScript、仓库与后端框架策略

- 状态：已接受
- 日期：2026-07-26
- 决策范围：当前技术验证阶段及其向多人协作产品演进的结构边界

## 背景

TaskSeal 当前是一个私有、单进程、零生产依赖的 Node.js ESM 项目，包含 CLI、本地 HTTP Control Room、领域规则、provider 适配器和 Codex runner。仓库已经形成清晰的依赖注入接缝，但 JavaScript 无法在提交前检查跨模块契约。

未来可能出现远程 API、多人协作、认证、数据库、队列、更多 runner/provider 以及独立 Web 前端，因此需要同时判断：

1. 是否迁移到 TypeScript；
2. 是否立即引入 NestJS；
3. 是否立即改成 monorepo。

## 决策

### 1. 渐进迁移到 TypeScript

采用 Node.js 24 原生 type stripping 直接运行服务端 `.ts` 源码，并使用 `tsc --noEmit` 建立独立类型门禁。

- 最低 Node.js 版本为 24.12。
- 只使用 erasable TypeScript；不使用 enum、parameter properties 等需要生成代码的语法。
- ESM 相对导入使用显式 `.ts` 扩展，纯类型导入使用 `import type`。
- 不建立 `dist/`，不增加生产运行依赖。
- 外部 JSON、HTTP、环境变量和子进程消息仍必须运行时校验；类型声明不能替代边界验证。
- `public/` 保持浏览器原生 JavaScript，直到单独决定前端构建方案。

### 2. 当前保持单 package

当前代码仍由一个 CLI/服务进程交付、一个版本发布、一个测试门禁验证。立即引入 workspaces 会增加包边界、构建顺序、版本和依赖管理成本，却没有独立部署或复用收益。

仓库先通过目录和依赖方向保持“monorepo-ready”：

```text
CLI / HTTP / runner / provider adapters
                  ↓
          application services
                  ↓
        framework-free domain
```

领域层不得依赖 NestJS、HTTP、文件系统或 provider SDK。应用层通过窄接口使用 runner、journal 和 provider 能力。

### 3. 当前不引入 NestJS

现有 Node.js `http` 服务只承担 loopback Control Room 和少量接口，尚无 NestJS 能明显降低的复杂度。此时加入 decorator、DI container、RxJS、adapter 和编译约束会扩大验证面。

当远程后端出现认证/授权、多租户、数据库事务、Webhook、队列、WebSocket、多个 API 模块或独立部署要求时，再以 `apps/api` 形式引入 NestJS。Nest controller 只能调用 application API，不得承载领域规则。

## 备选方案

### 单 package + `tsc → dist`

可兼容更旧 Node、decorator 和 npm 发布，但会立即引入构建产物、静态资源路径、shebang/bin、source map 和测试入口迁移。当前没有这些收益需求，因此暂缓。

### 立即使用 npm workspaces

适合已经存在多个可独立发布或部署的应用/包。TaskSeal 当前只有一个交付单元，过早拆包会把目录边界变成发布边界，因此不采用。

### 立即使用 NestJS + monorepo

适合明确的远程平台后端，但会同时改变运行时、依赖管理、目录、测试和部署。当前产品风险仍在交付闭环与插件契约，而不在 Web 框架能力，因此不采用。

## 升级触发条件

满足以下任一组条件时，创建新的 ADR 重新评估。

### 转为 monorepo

- 至少两个可独立部署的应用；
- runner/provider SDK 需要被仓库外消费者安装；
- Web 前端需要独立构建与发布；
- 不同模块需要独立版本、依赖或所有权门禁。

目标结构优先为：

```text
apps/
  cli/
  api/
  control-room-web/
packages/
  core/
  provider-github/
  provider-linear/
  runner-codex/
  journal-file/
```

### 引入 NestJS

- 后端从 loopback 工具变为远程、多用户服务；
- 需要认证、RBAC、租户隔离、数据库事务或审计中间件；
- 需要 Webhook、队列、定时任务、WebSocket 或多个可独立维护的 API 模块；
- 原生 HTTP 的路由、生命周期与横切逻辑已经产生可观测的维护成本。

### 改用编译产物

- 发布 npm CLI/SDK；
- 支持 Node.js 24.12 以下版本；
- 需要 decorator 或其他非 erasable TypeScript；
- 浏览器与服务端需要统一构建、source map 或打包优化。

## 影响

- 获得严格类型检查，同时保持生产依赖为零和当前运行路径。
- 迁移期间允许 `.js` 与 `.ts` 共存；每个切片必须更新显式扩展并通过完整测试。
- Node.js 版本门槛提高到 24.12。
- NestJS 与 monorepo 不是被否定，而是延迟到有实际边界证据时引入。

## 参考

- [Node.js TypeScript 文档](https://nodejs.org/api/typescript.html)
- [Node.js Test Runner 文档](https://nodejs.org/api/test.html)
- [NestJS Workspaces 文档](https://docs.nestjs.com/cli/monorepo)
- [TypeScript Project References](https://www.typescriptlang.org/docs/handbook/project-references)
- [npm Workspaces](https://docs.npmjs.com/cli/v8/using-npm/workspaces/)
