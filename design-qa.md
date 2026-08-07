# Design QA：原生控件与 shadcn 契约对齐

## 比较目标

- source visual truth path：`verification/design-qa/settings-components-before.png`；它固定现有
  Settings 的信息架构、内容、配色和布局。控件尺寸、圆角、focus ring 与交互状态以 shadcn
  Button、Field、Select、Switch 的公开契约为组件目标。
- implementation screenshot path：
  `verification/design-qa/settings-components-final-desktop.png`。
- responsive evidence：`verification/design-qa/settings-components-final-mobile.png`。
- viewport：桌面 CSS viewport `1349 × 1031`；移动端 CSS viewport `390 × 844`。
- pixels / density normalization：桌面 source 与 implementation 均为 `1334 × 1020` pixels，
  浏览器截图已归一到 CSS pixel 尺度；可见宽度扣除了滚动条。移动端截图为 `375 × 844`
  pixels，同样扣除滚动条。没有用缩放后的图片评估控件差异。
- state：`/settings`、简体中文、dark theme、`scrollY = 0`、Provider 配置全部收起；
  source 与 implementation 的项目数据、运行状态和配置 revision 相同。

## Findings

当前没有仍需处理的 P0、P1 或 P2 差异。

- [P3] 浏览器驱动没有提供历史 console message API。
  Location：浏览器运行诊断。
  Evidence：页面 reload、Linear disclosure、checkbox 切换/恢复、focus-visible 与移动端重排均
  成功，未出现页面错误或未处理异常；但无法读取页面加载前的历史 console buffer。
  Impact：不影响当前可见结果和主流程，属于诊断覆盖缺口。
  Fix：如果后续引入浏览器级 E2E runner，再增加 console/error event 断言。

## 五个必检表面

- Fonts and typography：页面字体家族和标题层级保持不变；表单控件统一为 `14px/20px`，
  普通值 `400`，按钮 `600`，紧凑导航保持 `13px`。未发现新的截断、异常换行或光学重量漂移。
- Spacing and layout rhythm：默认控件统一 `40px` 高、紧凑控件 `36px` 高、`8px` 圆角；
  nav active item 为 `7px` 内圆角。按钮、输入、选择、折叠 summary 和 switch 在桌面与窄屏
  使用同一节奏。`390px` viewport 下 `scrollWidth <= viewport`，没有横向溢出。
- Colors and visual tokens：边框、control background、accent、hover 和 focus ring 均映射到共享
  semantic token；没有引入第二套颜色或新增渐变。
- Image quality and asset fidelity：比较区域没有照片、插画或产品图；既有 TS brand mark 未修改，
  没有用占位图、emoji、手写 SVG 或 CSS 图形替换资产。
- Copy and content：设置标题、字段 label、来源、重启影响、Provider 文案和中英文 catalog 均保持
  原语义，没有把审计提示或设计说明泄漏到产品界面。

## Full-view comparison evidence

- source：`verification/design-qa/settings-components-before.png`
- implementation：`verification/design-qa/settings-components-final-desktop.png`
- 两张图已在同一比较输入中以相同 viewport、route、theme、locale、数据和滚动状态检查。
- 信息层级、hero、运行状态、配置来源侧栏和项目卡片比例保持一致；变化只发生在控件契约。

## Focused region comparison evidence

- source crop：`verification/design-qa/settings-controls-before.png`
- implementation crop：`verification/design-qa/settings-controls-final.png`
- 两个 crop 使用同一 `x=20, y=300, width=945, height=360` 区域；验证界面语言 Select、
  Control Room 端口 Input、保存 Button 的高度、圆角、字体、内边距和对齐关系。

## Comparison history

### Iteration 1 — blocked

- [P1] 同一页面存在四套控件尺寸：导航约 `33px`、locale Select 约 `34px`、表单
  Input/Select `44px` 且 `16px` 字号、Button `44px` 且 `11px` 圆角。
- [P2] Input/Select 的 focus ring 与 Button/Switch 不同，部分按钮 active/hover 还带位移。
- [P2] Switch 轨道尺寸、圆角和 thumb 比例没有遵循同一紧凑控件尺度。

Fixes made：在 `public/styles.css` 增加共享 control height、radius、font、border、background、
focus-ring tokens；统一 `.ui-input`、`.ui-select`、`.ui-textarea`、`.ui-button`、导航、折叠
summary 与 switch；移除按钮位移；为后声明的 Settings 规则增加最终契约覆盖，避免 cascade
重新引入旧尺寸；HTML 显式标记 Select 与 Textarea 组件类。

### Iteration 2 — passed

- post-fix visual evidence：
  `verification/design-qa/settings-components-final-desktop.png`、
  `verification/design-qa/settings-controls-final.png`、
  `verification/design-qa/settings-components-final-mobile.png`。
- measured evidence：默认 Input/Select/Button `40px`、`8px` radius、`14px`；locale/nav
  `36px`；summary `40px`；switch `36 × 20px`、thumb `14px`；focus ring 为背景 2px 加
  accent 4px 的双层 ring。
- interaction evidence：Linear disclosure 可展开/收起；ready-work checkbox 可切换并恢复原值；
  focus ring 可见；移动端导航、locale、表单字段和运行状态重排正常。
- 后续复核未发现 actionable P0/P1/P2 差异。

## Dashboard continuation QA（2026-08-03）

- source visual truth path：`verification/design-qa/dashboard-before-desktop.png` 与
  `verification/design-qa/dashboard-before-mobile.png`；当前产品配色、品牌、Runner 内容和
  operations-first 规格保持为设计约束。
- implementation screenshot path：`verification/design-qa/dashboard-final-desktop.png` 与
  `verification/design-qa/dashboard-final-mobile.png`。
- viewport：桌面 CSS viewport `1280 × 720`，source/implementation 均为 `1265 × 712`
  pixels；移动 CSS viewport `390 × 844`，source 为 `375 × 829` pixels（存在水平滚动条），
  implementation 为 `375 × 844` pixels。浏览器截图使用 CSS pixel density `1`。
- state：`/`、简体中文、persistent runtime、TS-1 selected、人工操作人未配置、Provider
  observation unavailable、`scrollY = 0`。
- full-view comparison evidence：四张图已在同一比较输入中按桌面前/后、移动前/后检查。
  focused region 未另做 crop，因为问题集中在首屏整体信息顺序、header reflow 和横向溢出，
  全屏证据已经能清晰读取相关控件和文案。

### Dashboard comparison history

#### Iteration 1 — blocked

- [P1] `390px` viewport 的 header 右侧超出 25px，语言选择和持久化状态被裁切。
- [P1] 工作流摘要完全位于首屏之外；未配置人工操作者时仍重复展示空验收 truth、空审计和
  不可用提示，核心运行状态被次要信息推迟。
- [P2] Provider toast、Runner accepted 状态和 ARIA live region 在中文界面输出英文。

Fixes made：移动 header 改为两行 reflow，隐藏窄屏冗余 runtime badge；摘要移动到 hero
overview，桌面与移动均使用 2 × 2 紧凑网格；operator-unavailable 状态隐藏重复 truth/audit，
只保留一个可操作提示；Provider state 增加稳定 message code 并在 presentation boundary
本地化；Runner、snapshot、orchestration、Provider live status 补齐中英文 catalog。

#### Iteration 2 — passed

- desktop：摘要从 viewport 外移动到 `top=268px, bottom=536px`，Runner bottom `520px`，
  首屏同时可见工作状态与任务控制。
- mobile：`scrollWidth=375 <= viewport=390`，无水平溢出；摘要 `top=331px,
  bottom=579px`，Runner 紧随其后 `top=599px`，不存在多余 flex-basis 空白。
- interactions：TS-1/TS-43 Select 切换和恢复成功；accepted Runner 状态显示
  “已验收；再次运行前需要显式重新打开”；未触发 Runner、Provider 或外部写操作。
- typography：保留现有 Segoe UI Variable/Aptos fallback，标题降至 `38–56px` 范围，
  status cards 与 Runner label 未出现截断或错误换行。
- colors/tokens：继续使用现有 charcoal/lime semantic tokens，没有新增颜色系统或装饰资产。
- image quality：页面没有照片/插画；TS mark 保持原实现，没有引入替代图形资产。
- copy/content：视觉文案与机器数据保持分离；新增 live status 只在 presentation 层翻译。
- 无仍需处理的 P0/P1/P2 finding。

## Dashboard information architecture and live activity QA（2026-08-05）

### Comparison target

- source visual truth path：`verification/design-qa/dashboard-ia-before-top.png`、
  `verification/design-qa/dashboard-ia-before-mobile.png`。它们固定本次调整前的真实首页状态，
  重点验证核心任务、Agent 轨迹、空编排和 Provider 状态之间的视觉优先级。
- implementation screenshot path：`verification/design-qa/dashboard-ia-after-wide.png`、
  `verification/design-qa/dashboard-ia-after-mobile.png`；次级状态证据为
  `verification/design-qa/dashboard-ia-after-secondary.png`。
- combined comparison evidence：`verification/design-qa/dashboard-ia-comparison.png` 与
  `verification/design-qa/dashboard-ia-mobile-comparison.png`；前后图已经放进同一比较输入检查，
  没有用分离截图冒充并排比较。
- viewport / normalization：桌面 source 与 implementation 均为 CSS viewport
  `1820 × 1196`、截图 `1805 × 1196` pixels、density `1`；移动端均为 CSS viewport
  `390 × 844`、截图 `375 × 844` pixels、density `1`。桌面前后没有缩放或拉伸。
- state：`/`、简体中文、persistent runtime、TS-1 selected、人工操作人未配置、Provider
  observation unavailable、无活跃 decomposition plan、`scrollY = 0`。

### Findings

当前没有仍需处理的 P0、P1 或 P2 差异。

- [P3] 工作项详情中的长 Attempt history 仍会让单个交付卡片较高。
  Location：`.attempt-history`。
  Evidence：核心队列和实时轨迹已在首屏，但向下查看次级编排状态仍需要越过完整历史。
  Impact：不影响查找最新 Attempt，因为右侧轨迹已经最新优先且保持可见；只影响深度浏览效率。
  Fix：后续可将工作项内历史默认限制为最近 3 条，并提供“查看全部”。

### Five required fidelity surfaces

- Fonts and typography：继续使用既有 Segoe UI Variable/Aptos 字体栈；标题从营销口号收敛为
  “交付控制台”，`AGENT 轨迹 / 实时运行轨迹`建立明确层级。最新记录、时间与摘要控制未出现
  截断或异常字重。
- Spacing and layout rhythm：桌面核心网格从 `top≈1495px` 提前到 `top≈569px`；编排和
  Provider 移到核心网格之后。空编排高度压至约 `176px`，Provider error 状态约 `204px`，
  不再使用 150/280px 的居中空白占位。右侧轨迹在桌面滚动时保持 sticky 且自身有界。
- Colors and visual tokens：沿用现有 charcoal/lime、border、surface 与 semantic status token；
  “最新”只使用低对比 accent badge，没有引入新的颜色系统或高噪声装饰。
- Image quality and asset fidelity：首页没有照片、插画或产品图；既有 TS mark 未修改，也没有用
  emoji、手写 SVG、CSS 插画或占位资产替换可见资源。
- Copy and content：Hero 文案改为运行总览语义；轨迹明确写出“最新 Attempt 优先”；完整运行
  summary 保留原始事实但默认折叠，没有丢失审计内容。

### Full-view and focused comparison evidence

- full-view：`dashboard-ia-comparison.png` 清楚显示调整前空编排和 Provider 占据核心区域，
  调整后同一位置变为交付队列与实时轨迹。
- focused secondary state：`dashboard-ia-after-secondary.png` 验证空编排和 Provider error 已
  收缩为次级状态，不再形成大面积无内容容器。
- focused live activity：桌面 implementation 中最新 Attempt 位于第一条、带“最新”标记和时间；
  完整 summary 通过原生 `details/summary` 展开。该区域文字在全视图截图中可清晰读取，因此未再
  制作重复 crop。

### Comparison history

#### Iteration 1 — blocked

- [P1] 交付队列位于 `top≈1495px`，首屏核心位置被没有内容的分解控制和不可用 Provider 占据。
- [P1] Agent 轨迹把旧 Attempt 放在第一条，并把长 summary 拼进主标签，用户难以判断最新运行。
- [P2] `390px` 窄屏先显示较长 Runner、编排和 Provider，再显示队列/轨迹，信息优先级进一步倒置。

Fixes made：调整首页 DOM 顺序；桌面使用交付队列 + sticky 实时轨迹核心网格；窄屏将实时轨迹
置于队列卡片之前，再显示 Runner；空编排和 Provider error 使用 `data-state` 收缩；抽取
`createAttemptTimeline`，按 `startedAt` 降序、限制 12 条、拆分 summary，并对最新记录提供
`aria-current` 与视觉标记。

#### Iteration 2 — passed

- post-fix desktop：队列和轨迹同为 `top≈569px`；第一条是 Attempt
  `199b51f0-220e-4a64-82bd-c0819cbfb128`，状态“已完成”，带“最新”标记。
- post-fix mobile：核心网格 `top≈563px`，实时轨迹为网格第一项，工作项详情第二，Runner 与
  次级集成控制排在之后；`scrollWidth <= clientWidth`，无横向溢出。
- interaction evidence：点击“查看运行摘要”后 `details.open === true`；等待 1.8 秒后快照文案
  从 `17:23:42` 更新为 `17:23:59`，证明 1.5 秒轮询仍在实时刷新。
- accessibility：最新项使用 `aria-current="true"`；折叠摘要使用原生 disclosure；桌面和窄屏
  均未发现核心控件裁切。
- 后续复核未发现 actionable P0/P1/P2 差异。

## Implementation Checklist

- [x] 统一 semantic control tokens。
- [x] 统一 Button、Input、Select、Textarea、Disclosure 与 Switch。
- [x] 覆盖 Settings 晚声明规则的 cascade 漂移。
- [x] 验证 focus-visible 与可操作状态。
- [x] 验证桌面与 390px 窄屏无横向溢出。
- [x] 保存同状态全屏与 focused crop 证据。
- [x] 将 Dashboard 状态摘要移入首屏并压缩不可用验收状态。
- [x] 修复 390px header 横向溢出与移动端 flex 空白。
- [x] 验证工作项切换、中文 Runner 状态和 ARIA live region。
- [x] 将交付队列和实时 Agent 轨迹提升到编排与 Provider 之前。
- [x] 将轨迹改为最新优先、摘要按需展开，并保留轮询刷新。
- [x] 收缩空编排和不可用 Provider 的占位高度。
- [x] 验证 `1820 × 1196` 桌面与 `390 × 844` 窄屏信息层级。

## Open Questions

- 无阻断问题。完整历史 console 断言留作引入浏览器 E2E runner 后的 P3 覆盖增强。

## Follow-up Polish

- 后续可以将共享原生组件契约拆成独立 CSS layer，减少现有单文件 stylesheet 的 cascade
  维护成本；这不影响本次交付。

final result: passed
