# TaskSeal

> Proof before done.

TaskSeal 是一个本地优先的 AI 交付控制原型。它把工作项、Agent 执行、交付物、验证证据和人工验收串成可复核闭环。

**Agent 执行完成不等于任务完成。只有当前 Attempt、Artifact、Required Evidence 和人工 AcceptanceDecision 全部有效，WorkItem 才会进入 `accepted`。**

## 安装与调用

| 方式 | 状态 | 调用方式 |
| --- | --- | --- |
| 源码运行 | 支持，推荐 | `npm run taskseal -- <command>` |
| 本地 tarball 安装 | 支持 | `npm exec -- taskseal <command>` |
| npm registry 安装 | 不支持 | package 尚未公开发布 |
| Runner / Provider / Plugin SDK v1 | 支持 | 使用版本化 package exports |
| 第三方插件安装与动态加载 | 不支持 | 目前只检查 manifest 和合同 |
| Hosted / 远程访问 | 不支持 | Control Room 只监听本机 loopback |

要求：

- Node.js `>=24.12.0 <25`
- 已安装并登录 Codex CLI

### 从源码运行

```bash
npm ci
npm run taskseal -- init
npm run taskseal -- doctor
npm run taskseal -- demo init
npm run taskseal -- run TS-1 --prompt "Reply with a short status."
npm start
```

打开 `http://127.0.0.1:7331` 查看当前正在执行、需要处理和下一批任务；进入
`http://127.0.0.1:7331/projects` 查看所有已登记项目，进入
`http://127.0.0.1:7331/connections` 查看连接真相，进入 `/settings` 编辑配置。首页不再
要求先选择 WorkItem，运行、取消和验收只在任务上下文中出现。Connections 只展示 effective
配置来源、凭据存在性和最近观察，不返回 Secret；Provider 坐标保存后按 operation revision
供下一次 operation 使用，端口、模式等 process-bound 字段仍按运行时重启规则处理。

- `init`：创建 `.taskseal/` 和最小 `config/project.json`，不创建 WorkItem，不覆盖现有配置。
- `demo init`：额外幂等创建示例 WorkItem `TS-1`。
- `run`：默认 `read-only`；只有显式传入 `--workspace-write` 才允许 Agent 修改工作区。
- `start`：启动单个本地 Control Room；同一工作区的第二个实例会被拒绝。
- `status`：读取统一项目运行视图；未启动 Control Room 时只重放本地 journal 并标记为 offline。
- `work list/show`：按项目查看 WorkItem 名称、状态、耗时、证据门禁和下一动作。
- `integration test <provider>` 默认只检查本地配置；追加 `--connect` 才执行一次有界的只读联网验证。

如果需要在项目总览中登记同一工作区下的其他项目，可创建 `config/projects.json`：

```json
{
  "schemaVersion": "project-registry/v1",
  "projects": [
    { "projectRef": "other-project", "workspace": "projects/other-project", "name": "Other Project" }
  ]
}
```

登记项只允许工作区内的相对路径；总览只读已验证的 loopback Control Room 或本地 journal，
不会自动启动其他项目、抢占写锁或执行 Provider 写操作。

### 安装到其他仓库

```bash
# 在 TaskSeal 仓库打包
npm pack

# 在目标仓库安装并初始化
npm install <path-to-taskseal-tarball>
npm exec -- taskseal init
npm exec -- taskseal doctor
npm exec -- taskseal setup
npm exec -- taskseal start
```

安装包运行编译后的 `dist/`。公开 SDK 入口：

- `taskseal/runner/v1`
- `taskseal/provider/v1`
- `taskseal/plugin/v1`
- `taskseal/testing/runner/v1`
- `taskseal/testing/provider/v1`

## 配置

TaskSeal 使用分层配置：

| Scope | 位置 | 当前用途 |
| --- | --- | --- |
| User | Windows `%APPDATA%\TaskSeal\config.json`；macOS `~/Library/Application Support/TaskSeal/config.json`；Linux `$XDG_CONFIG_HOME/taskseal/config.json` | `ui.locale` |
| Project | [`config/project.json`](config/project.json) | 项目和 Provider 治理配置 |
| Local | `.taskseal/config.local.json` | 本机 Control Room 端口 |
| Environment | 进程环境 | 临时覆盖和 Secret binding |
| Command | 当前命令 | `--lang` 等一次性覆盖 |

普通字段按 Command、Environment、Local、Project、User、Built-in 的顺序解析，但每个字段仍受允许的 scope 限制。User/Local 配置不能放宽项目 Provider scope，也不能持久化 `workspace-write`。

完整约束：[`schemas/project-config.schema.json`](schemas/project-config.schema.json)

最小配置即可启动本地能力：

```json
{
  "project": "MyProject"
}
```

未配置的 Provider 会显示为 `disabled`，不会阻止 `doctor` 或本地 Control Room 启动。配置了 Provider 但字段无效时，`doctor` 与 `start` 会使用同一套 Readiness 校验并拒绝启动。

用户语言配置：

```json
{
  "ui": {
    "locale": "zh-CN"
  }
}
```

支持 `auto`、`en` 和 `zh-CN`。Control Room 顶部和 Settings 页面都可即时切换；选择结果
写入 User scope，不要求重启。也可以用 `--lang en` 或 `--lang zh-CN` 临时覆盖；`--json`
的字段、状态和错误码不随语言变化。

本机端口配置：

```json
{
  "runtime": {
    "port": 7331
  }
}
```

读取和校验配置不会访问 Provider：

```bash
npm run taskseal -- config list
npm run taskseal -- config get ui.locale --lang zh-CN
npm run taskseal -- config validate --json
npm run taskseal -- config set ui.locale zh-CN
npm run taskseal -- config set runtime.port 4400 --json
npm run taskseal -- config unset runtime.port
npm run taskseal -- config edit project
npm run taskseal -- help config
npm run taskseal -- config template github
npm run taskseal -- config template linear --json
```

`help <command>` 与 `<command> --help` 只显示对应分命令。`config template` 支持
`github`、`linear`、`feishu` 和 `gitee`，只输出可以合并到 `config/project.json` 的配置片段，
不会读取当前项目或凭据，也不会执行网络请求。模板中的仓库、工作区和飞书 scope digest
都是占位值，使用前必须替换；Token/Secret 继续仅通过受支持的环境变量注入。

`set` 和 `unset` 会先生成绑定当前综合 revision 的规范化 plan，再校验 plan digest、获取写锁并使用同目录原子替换。过期、篡改、并发冲突和不允许持久化的字段都会在写入前失败；运行时字段成功更新后会明确提示重启 Control Room。

如果启动提示 `CONTROL_ROOM_PORT_UNAVAILABLE`，说明配置端口已被其他本机程序独占或禁止绑定。使用 `taskseal config set runtime.port <port>` 持久选择其他端口，或者用 `PORT=<port>` 做单次覆盖。TaskSeal 不会静默改用其他端口，以免页面地址与 ConfigurationView 的配置权威不一致。

需要同时调整多个相互依赖字段时，使用 `config edit user|project|local`。TaskSeal 只把当前配置副本写入权限受限的临时文件，编辑器退出后会整体解析和校验草稿，再通过同一套 digest、revision CAS、写锁与原子替换提交；编辑器失败、无效 JSON、非法字段或并发更新都不会覆盖正式配置。编辑器按 `TASKSEAL_EDITOR`、`VISUAL`、`EDITOR` 的顺序选择，支持带引号的可执行路径和参数，并始终以参数数组启动，不经过 shell。

Control Room 运行期间，`config list/get/validate/set/unset/edit` 会读取 lock 中的 loopback endpoint 和随机 instance ID，验证响应身份后把请求转交给运行实例。lock 存在但 endpoint、身份或响应无法验证时固定返回 `CONTROL_ROOM_HANDOFF_UNAVAILABLE`，不会退回离线文件写入。运行实例仍调用同一个 Configuration Control Module，修改 runtime 字段后继续明确提示重启。

Settings 与 CLI 共用同一个配置权威。页面会比较启动时的 active runtime revision 和当前
desired runtime revision：语言变化立即生效且不会制造重启提示；端口或项目运行参数变化会
保留在 desired 配置中，并显示持久提示与可复制的 `taskseal start` 命令。当前进程没有
supervisor，因此页面不会伪装成可以安全自重启。

Provider 设置按 GitHub、Linear、飞书和 Gitee 分组，默认只展示连接状态与官方访问管理
入口，非 Secret 坐标需要时再展开。页面与配置 API 只返回凭据是否存在及环境变量名称，
不会返回 Token/Secret 值。当前版本不声称提供一键 OAuth；真实 OAuth 需要注册 Provider
应用、PKCE/state、回调处理和 OS keychain 或等价 Secret Vault，安全边界见
[`docs/adr/0022-provider-onboarding-and-native-component-contract.md`](docs/adr/0022-provider-onboarding-and-native-component-contract.md)。

| 配置 | 用途 |
| --- | --- |
| `github.repository` | GitHub `owner/repo` |
| `github.delivery` | GitHub Delivery 对账开关和 mapping index |
| `linear.workspace/team/project` | Linear 精确范围 |
| `linear.backlogState` | `sync linear --dry-run` |
| `linear.readyWork` | Linear 候选领取与本地导入 |
| `linear.acceptance` | 验收后的可选 Linear 状态迁移 |
| `gitee.repository` | Gitee 公共仓库只读检查 |
| `feishu.enabled/tableScopeKey` | 飞书固定表格只读检查 |

关键环境变量：

| 环境变量 | 说明 |
| --- | --- |
| `TASKSEAL_CODEX_BIN` | 可选，Codex 可执行文件 |
| `TASKSEAL_EDITOR` | 可选，`config edit` 使用的编辑器命令；优先于 `VISUAL` 和 `EDITOR` |
| `TASKSEAL_MAX_CONCURRENT_RUNS` | `1`～`8`，默认 `1` |
| `TASKSEAL_HUMAN_ACTOR` | 启用本地人工验收；值为稳定、非敏感操作者 ID |
| `HOST` / `PORT` | 默认 `127.0.0.1:7331`；HOST 只允许 loopback |
| `GITHUB_TOKEN` / `GH_TOKEN` | GitHub 私有资源或更高读取限额 |
| `LINEAR_API_KEY` / `LINEAR_ACCESS_TOKEN` | Linear 读取或受控状态迁移；二选一 |
| `TASKSEAL_FEISHU_*` | 飞书应用凭证、表格坐标和字段映射 |

TaskSeal 不自动加载 `.env`。密钥只能由 shell 或启动进程注入，不得写入仓库、配置或日志。

## 运作流程

```text
Linear ready work
  → 人工审阅并导入本地 WorkItem
  → Codex Runner 执行 Attempt
  → GitHub Artifact / Evidence 对账
  → 人工 AcceptanceDecision
  → 可选 Linear Done 迁移与读回
```

1. `ready linear`：先列候选，再 `preview`，最后用相同 plan digest `apply`。只写本地 journal。
2. `run <id>`：执行 Agent。成功只表示 Attempt completed，不表示验收通过。
3. `reconcile github`：先 `preview`，再用相同 plan digest `apply`。只采集并写入本地 Artifact/Evidence。
4. Control Room 人工 accept/reject：只接受当前 Attempt 对应的 Artifact 和全部 Required Evidence。
5. 仅当 `linear.acceptance.enabled: true` 时，验收后才会受控迁移 Linear 状态并读回确认。

正式 WorkItem 通过 `ready linear ... --mode apply` 或 application-owned import 进入；`demo init` 仅用于演示。

常用命令：

```bash
npm run taskseal -- ready linear
npm run taskseal -- ready linear --mode preview --issue <linear-uuid> --work-item <id> --criterion tests
npm run taskseal -- ready linear --mode apply --issue <linear-uuid> --work-item <id> --criterion tests --expected-plan-digest <sha256>
npm run taskseal -- run <id> --prompt "<instruction>"
npm run taskseal -- run <id> --workspace-write --prompt "<instruction>"
npm run taskseal -- reconcile github --mode preview --work-item <id>
npm run taskseal -- reconcile github --mode apply --work-item <id> --expected-plan-digest <sha256>
```

其他入口：

| 命令 | 用途 |
| --- | --- |
| `doctor` | 检查 Node、项目配置、Codex 登录和各集成状态 |
| `config list/get/validate` | 查看来源、有效值和诊断；支持稳定 JSON 输出 |
| `config set/unset/edit` | 通过 preview、CAS 和原子替换更新允许持久化的单字段或多字段配置 |
| `inspect github-issue/github/linear/gitee/feishu` | Provider 只读观察 |
| `sync linear --dry-run` | 从仓库 ticket 生成草案，不联网、不写外部系统 |
| `plugin check <manifest.json>` | 静态检查插件 manifest，不加载插件代码 |
| `--help` | 查看命令列表 |

`inspect` 不写 Provider，但会更新本地 `.taskseal/provider-observations.json`。

## 当前能力与边界

| 能力 | 状态 |
| --- | --- |
| Control Room | 本机可用；派发、取消、重试、验收和状态展示 |
| Runner | 内置 Codex App Server Adapter；支持 v1 合同、超时、取消、有界并发 |
| 任务分解 | 有界 DAG、人工审批、显式派发和验收门禁 |
| Linear | ready work 只读领取、本地导入；验收后状态迁移可选 |
| GitHub | Issue/PR/Check/Review 只读采集和本地 Evidence 对账 |
| Gitee / 飞书 | 固定范围只读观察，不导入、不写回 |
| 持久化 | 本地 JSON/JSONL；支持重放和审计；Control Room 使用工作区单实例锁 |

除显式启用的“人工验收后 Linear 状态迁移”外，运行时不执行外部 mutation。

若进程异常退出后遗留 `.taskseal/control-room.lock`，必须先确认没有 TaskSeal Control Room 进程，再人工移除；系统不会自动猜测并清理未知 lock。

## 待办事项

- [x] 增加分命令帮助和可选 Provider 配置模板生成。
- [ ] 发布可版本化安装的预览包。
- [ ] 实现第三方插件发现、安装、签名/信任、隔离和动态加载。
- [ ] 补齐 Gitee CLI/HTTP import、飞书受控 import。
- [ ] 为多进程或团队部署引入单写服务/数据库、备份恢复和并发控制。
- [ ] 真实团队试点后再建设认证、RBAC、租户隔离、TLS、部署和可靠性目标。

## 验证与文档

```bash
npm run typecheck
npm test
```

- [本地入口与 Readiness 规格](docs/specs/0026-local-cli-readiness-and-onboarding.md)
- [统一 Runtime Readiness ADR](docs/adr/0018-unified-local-runtime-readiness.md)
- [安装包与 SDK 规格](docs/specs/0024-installable-cli-plugin-sdk.md)
- [Runner 架构](docs/architecture/codex-runner.md)
- [Provider / Connector 架构](docs/architecture/connectors.md)
- [工作跟踪规则](docs/standards/work-tracking.md)
