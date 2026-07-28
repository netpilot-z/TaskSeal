# 审查 0021：Control Room 执行控制

## 范围

本次审查覆盖 Linear `NP-5` / T17：

- application-owned Attempt 运行协调；
- Control Room 的任务选择、派发、取消、重试和有界并发；
- Codex Runner 的取消终态持久化；
- Persistent dashboard 的运行状态与 Attempt 历史；
- CLI 并发配置、HTTP 写安全边界和 shutdown。

## 独立审查结论

### 后端与并发

首轮审查复现了三个问题：

1. terminal append 已开始时，cancel 可能返回已接受，但最终仍写成 `completed`；
2. signal abort 会让 server 吞掉 terminal journal 写入失败；
3. 注入式 executor 同步重入 shutdown 时，shutdown 可能提前返回。

修复后复审确认：

- coordinator 提供同步 terminalization fence；
- 栅栏前已接受的取消强制选择 `interrupted`；
- 栅栏后才到达的取消返回 `409 RUN_TERMINALIZING`；
- terminal journal/service/未知错误进入安全 `runtime.errors`；
- executor 调用前已经登记 deferred execution，shutdown 始终等待 settle；
- 未发现剩余 P1/P2。

### 前端、交互与可访问性

首轮与后续复审发现并关闭：

- 卡片重渲染造成键盘焦点丢失；
- mutation 期间可切换目标，导致可见选择与请求目标错位；
- 容量耗尽文案错误暗示已经排队；
- dashboard 轮询重复改写 live region；
- 切换 WorkItem 覆盖尚未派发的自定义 assignment；
- 聚焦卡片被删除后缺少焦点退路，包括最后一项被删除的空列表场景。

最终实现按 WorkItem 保存 session draft；busy 时禁用选择；重渲染恢复原焦点，原项消失时转移到新选中卡片，空列表则聚焦带明确语义的 empty state。最终复审未发现剩余 P1/P2。

## 验证证据

- 定向 coordinator、runner、server、CLI 和 dashboard state 回归通过。
- 主实现 pass 与独立 verification pass 各运行一次 `npm test`：TypeScript 检查与 `705/705` 测试均通过。
- 浏览器桌面视口 `1280 × 720`：Control Room 首屏、选择器、runner 控件和 Provider 区域布局正常。
- 浏览器移动视口 `375 × 812`：无横向页面溢出；select、Run、Cancel 高度约 `44px`；长 Attempt ID 可换行。
- 键盘选择保持原生按钮语义、`aria-pressed` 和可见 focus。
- 浏览器 console error 为零。
- 独立扫描确认当前修改/新增文件不含开发者机器绝对路径或明显凭证；`git diff --check` 无 whitespace error；未新增生产依赖。

## 已知限制

- coordinator 只保证单 Control Room 进程，不提供跨进程锁。
- HTTP `202` 只承诺进程内 dispatch accepted，不承诺 `attempt.started` 已经持久化。
- 默认并发为 `1`；显式设置 `2`～`8` 才允许无关 WorkItem 并行。
- 本切片不提供等待队列、自动 retry、优先级或 DAG 调度。
- 本地浏览器数据只有一张 WorkItem；多任务选择、草稿切换和删除回退由纯状态测试与独立代码审查覆盖。

## 结论

NP-5 的实现满足 T17 合同，可以进入 PR 与 CI 门禁。取消、持久终态和 shutdown 的关键竞态均有失败复现与回归测试，未发现阻止合并的问题。
