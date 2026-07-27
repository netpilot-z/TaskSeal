# 审查 0009：CLI 与源码 Bin TypeScript 迁移

## 状态

通过。对应 GitHub Issue `#28`；审查对象是 CLI、三个直接测试、private package 入口、README 与迁移记录。

## 独立审查范围

进行了两个独立只读 pass：

1. CLI、进程与安全 pass：参数、退出码、依赖注入结果、错误裁剪、child process、Codex 探测、listen、signal、shutdown 与 main guard。
2. Verification pass：类型检查、直接与全量测试、Windows direct/npm smoke、Linear dry-run、shebang/LF/Git mode、pack 内容、diff、类型逃生口、绝对路径和凭证。

## Finding 与闭环

### P2：README 的当前命令仍引用已删除的 JavaScript CLI

验证 pass 发现 README 八条当前使用示例仍运行 `src/cli.js`，迁移后会直接失败；历史 runner ticket 也保留旧验证入口。

修复后：

- README 的 init、doctor、run、inspect 与 sync 示例统一改为 `src/cli.ts`；
- 历史 ticket 保留原切片语义，同时明确当前迁移后的测试和 doctor 入口；
- 全仓旧 `src/cli.js` 与 `test/cli.test.js` 的可执行引用扫描为 0。

### 发布边界：pack mode 不能证明可安装 CLI

Windows 的 `npm pack --dry-run --json` 把 `src/cli.ts` 报告为 `0644`，且 Node 不支持对 `node_modules` 内 `.ts` 做原生 type stripping。该证据不作为本切片失败，因为 package 明确为 `private: true`，验收对象是源码 checkout；同时已创建 Issue `#32`，要求在真正分发前产生 JavaScript 发布物并执行隔离安装。

最终未发现其他 P0–P3。

## 验证证据

- `npm run typecheck`：通过。
- CLI 定向测试：25/25 通过。
- `npm test`：249/249 通过，0 fail、0 skipped、0 todo。
- Windows direct/npm unknown command：均为 exit 2 且输出 Usage。
- Windows direct/npm Linear dry-run：均为 exit 0、8 个 drafts、0 network request、0 external write。
- CLI 文件：正确 shebang、LF only、结尾 LF、Git mode `100755`。
- PR `#33` Ubuntu CI 实际执行 POSIX raw `src/cli.ts`，验证 exit 2 与 Usage 并通过。
- pack 预览：包含 `src/cli.ts`，不包含 `src/cli.js`，未产生 tarball；`0644` 限制已进入 Issue `#32`。
- `git diff --check`：通过。
- 目标文件 `any`、类型断言、TypeScript ignore、测试 skip/only、本地绝对路径、私钥/token/credential/Bearer literal：0。
- 生产依赖仍为 0。

## 剩余风险

- package 不能发布或从 `node_modules` 运行原生 `.ts`；可分发 CLI 不是 Issue `#28` 的能力。
- npm pack 仍提示没有 `.npmignore` 并包含测试等开发文件；发布 files/exports 清单必须在 Issue `#32` 收敛。
- main guard 面向源码直接执行；npm 安装 shim/symlink 行为也必须在 Issue `#32` 的隔离安装测试中验证。

## 结论

Issue `#28` 已完成 private/source-checkout CLI 的 strict TypeScript 迁移，保持命令与安全边界，并把可安装发布物从源码运行能力中明确分离；Windows 与 Ubuntu source entry 均已获得进程级验证。
