# ADR 0021：English 与简体中文 Presentation Contract

## 状态

已接受。

## 背景

TaskSeal 当前 Web 和 CLI 人类输出以 English 为主，项目文档和主要操作者又使用简体中文。
如果在 HTML、JavaScript、CLI route 和 Runtime Readiness 中分别替换文案，会形成多套
locale 解析、翻译和 fallback 规则，并可能把翻译后的状态或错误句子误当作 machine
contract、journal data 或 command input。

国际化必须允许人类切换语言，同时保持 WorkItem、Attempt、Evidence、AcceptanceDecision、
Provider operation、JSON、schema 和 persisted journal 的稳定性。

## 决策

1. 首版明确支持 `en` 与 `zh-CN`；English 是最终 fallback。
2. 国际化只存在于 presentation Adapter，不进入 Domain、journal、Provider、Runner 或
   machine JSON contract。
3. 建立 presentation-owned I18n Module，集中 locale normalization、catalog lookup、
   interpolation 与 `Intl` formatting。
4. CLI 直接调用该 Module；Web 通过只读、版本化 catalog endpoint 使用同一 catalog。
5. User configuration 使用 `ui.locale: auto|en|zh-CN`；`--lang` 或当前页面 session 可临时
   覆盖；Project scope 不能设置个人语言。
6. 页面语言切换立即生效，不要求 runtime restart，不写 canonical journal，不访问 Provider。
7. Application diagnostic 使用稳定 `code + messageKey + safe params`，由 CLI/Web Adapter
   本地化；persisted data 不保存翻译后的句子。
8. English 与简体中文 catalog key 和 interpolation placeholder 必须完全一致，并由自动化
   测试门禁。
9. WorkItem title、Runner instruction、Acceptance reason、Provider title 等用户或外部数据
   原样展示，不翻译。
10. `<html lang>`、ARIA、screen-reader-only、live region、validation message、日期与数字展示
    都属于国际化范围。

## Interface

```ts
resolveLocale(preferences): SupportedLocale
createPresentation(locale): LocalizedPresentation
```

`LocalizedPresentation` 只接受稳定 message key 与安全 interpolation parameters。Catalog
是纯文本资源，不允许 HTML、脚本、Markdown 或以翻译驱动业务分支。

## Locale resolution

```text
CLI: --lang > user ui.locale > OS locale > en
Web: session selection > process --lang > user ui.locale > browser locale > en
Machine JSON: fixed contract, no localized message
```

`auto` 继续解析 OS 或 browser locale。`zh`、`zh-Hans` 与中文 browser preference 归一化为
`zh-CN`；未知 locale 回退到 `en`。

## 选择理由

删除 I18n Module 后，locale resolution、fallback、interpolation、date/number formatting 和
missing-key handling 会散落到 CLI、Setup、Control Room 与测试，说明该 Module 能提供
Leverage 与 Locality。

把国际化放在 presentation Seam 上，可以让人类语言变化而 machine contract 不变化。
一套 catalog 同时服务 CLI 与 Web，避免同一句诊断在两个入口出现不同含义。

## 被拒绝方案

### 只在浏览器替换静态文案

CLI、doctor、validation、ARIA 与 server diagnostic 会继续混用语言，并产生第二套翻译。

### 把翻译后的 message 写入 JSON 或 journal

这会让自动化、审计和回放结果依赖 locale，破坏稳定 contract，也使历史数据无法统一查询。

### 使用 Project scope 保存语言

locale 是操作者偏好，不是项目治理规则。提交到仓库会让一个用户的偏好覆盖其他用户。

### 首版引入第三方 i18n framework

当前只有两个 locale、静态 catalog 和标准 ICU 之外的简单插值需求。Node 与浏览器内置
`Intl` 足够验证产品价值；出现复数、复杂语法或更多 locale 后再评估真实第二实现。

### 自动翻译用户与 Provider 数据

自动翻译会改变可审计原文、产生误译，并可能让 WorkItem、Issue 与 Acceptance reason
失去来源一致性。

## 影响

- 所有新增 user-visible string 必须先定义 message key，再进入两个 catalog。
- 既有 HTML、JavaScript 和 CLI hard-coded string 需要按实施切片逐步迁移。
- Application diagnostic 需要从预格式化句子逐步迁移为 code、messageKey 与 safe params。
- package install smoke 必须验证两个 catalog 都被打包。
- 浏览器 QA 和 CLI snapshot 必须同时覆盖 `en` 与 `zh-CN`。

## 回退

English catalog 保持完整 fallback。若中文 presentation 出现严重问题，可临时固定 resolved
locale 为 `en`，不会改变配置、Domain、journal 或 machine JSON。不能通过删除 message key
或让 JSON 返回翻译后句子进行回退。
