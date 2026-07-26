# 实验 0004：TypeScript 运行策略

## 实验卡

- 决策：TaskSeal 的渐进式 TypeScript 迁移应使用 Node.js 24 原生 type stripping，还是先建立 `tsc → dist` 构建链。
- 假设：在当前 Node.js 24.15 环境中，erasable TypeScript、显式 `.ts` ESM import 和 `.test.ts` 可以直接执行；配合独立 `tsc --noEmit` 即可在不改变目录/静态资源路径的前提下建立类型门禁。
- 反证：需要额外 runtime loader、Node test runner 无法发现 `.test.ts`、显式 `.ts` import 无法运行，或必须使用会生成 JavaScript 的 TypeScript 语法。
- 指标：直接运行和 Node test 均退出 0；不生成 JavaScript；生产运行依赖仍为 0。
- 边界：不验证 NestJS decorator、浏览器 TypeScript、npm 发布包、`node_modules` 中的 `.ts`、旧 Node 版本或断点调试器。
- 时限：20 分钟；任一核心命令失败即停止并选择 `tsc → dist`。
- 环境：Windows、Node.js 24.15.0、npm 11.12.1、ESM package。

## 结果

支持假设。

### 证据

在 Node.js 24.15.0 中执行：

```text
node tmp/typescript-runtime-prototype/main.ts
node --test tmp/typescript-runtime-prototype/value.test.ts
npx --yes --package typescript@6.0.3 tsc -p tmp/typescript-runtime-prototype/tsconfig.json
```

结果：

- `.ts` 入口可直接运行并输出预期值。
- Node test runner 发现并通过 `.test.ts`。
- `.ts` ESM relative import 可直接使用显式 `.ts` 扩展。
- TypeScript 6.0.3 strict/noEmit 检查通过。
- 实验目录未产生 `.js`、`.mjs` 或 `.cjs` 文件。

### 结论与边界

首阶段采用 Node.js 24 原生 type stripping + `tsc --noEmit`，不建立 dist 构建链。为避免依赖仍处于早期 Node 24 的行为，项目最低版本提升到已稳定支持 type stripping 的 Node.js 24.12。

生产代码只允许 erasable TypeScript，不使用 enum、parameter properties 等需要转换的语法。NestJS decorator、浏览器代码和可发布 npm 包不在本实验结论内；出现这些需求时重新评估编译输出。

实验代码为一次性资产，验证完成后删除，不进入 production tree。
