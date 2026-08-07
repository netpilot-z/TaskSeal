# ADR 0022：Provider 接入引导与原生组件契约

## 状态

Accepted，2026-08-03。

## 背景

Settings 已能编辑统一 ConfigurationView，但把所有 Provider 字段平铺后，常见配置与高级
坐标混在一起。首页的人工验收控件在能力不可用时仍显示为 disabled，也容易被误认为无法
输入的全局配置。

项目当前为零生产依赖的原生 HTML/CSS/JavaScript 原型。直接引入 shadcn/ui 会同时引入
React、Tailwind 与相关构建约束，超出规格 0027 的非目标。另一方面，GitHub、Linear 与飞书
的一键 OAuth 都需要预先注册应用、固定回调地址和安全保存 refresh token，不能只靠一个
跳转链接安全完成。

## 决策

1. Settings 将 Project 基础字段与 Provider 连接拆开。每个 Provider 使用同一种连接卡片：
   access presence、环境变量绑定名称、官方访问设置入口，以及按需展开的非 Secret 坐标。
2. ConfigurationView 只返回 credential presence、binding 名称和固定官方入口，永不返回
   Token、Secret 或 Cookie 值。
3. 当前版本不声称支持 OAuth。GitHub、Linear、飞书先跳转各自官方访问设置页，并继续通过
   环境变量提供凭据。
4. 后续 OAuth 只能在新增安全规格后落地：
   - GitHub CLI/headless 优先评估 Device Flow；
   - Linear 使用 Authorization Code + PKCE、`state` 和 refresh-token rotation；
   - 飞书使用 Authorization Code + PKCE，并预先登记 redirect URI；
   - refresh token 必须进入 OS keychain 或等价 Secret Vault，不进入项目配置、日志或 Web
     响应。
5. 不安装 shadcn/ui。采用其可组合组件与 semantic token 思路，在现有样式表中维护
   `ui-input`、`ui-select`、`ui-button`、Switch、status chip、disclosure 和 focus ring 的
   原生组件契约。
6. 被 Environment 或 Command source 锁定的值继续显示，用只读文本解释 effective value
   与 source，不再伪装成 disabled 输入框。
7. process-bound save（端口、模式、存储和 runner 能力）显示持久 restart banner 与可复制
   命令。Provider 坐标按 ADR 0023 绑定到下一次 operation；当前 in-flight operation 不漂移。
   首版不提供 Web 进程自重启，因为当前 Control Room 没有 supervisor；进程内重启会破坏
   响应交付与 writer-lock 所有权。
8. 首页能力不可用的人工验收表单不显示，改为解释原因；只有缺少人工操作人时提供 Settings
   入口。Cancel 操作只在确实可取消时出现。

## 依据

- GitHub OAuth Device Flow：<https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps>
- Linear OAuth 2.0 与 PKCE：<https://linear.app/developers/oauth-2-0-authentication>
- 飞书 OAuth code：<https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code>
- shadcn/ui theming：<https://ui.shadcn.com/docs/theming>

## 后果

- 高频配置更短，Provider 字段仍保持完整可达；页面 load/save 不访问 Provider，也不执行外部写。
- 用户可以安全跳转到官方访问管理页，但仍需按提示设置环境变量并重启。
- 若未来引入真实 OAuth，需要新的 token lifecycle、revocation、keychain、callback server 和
  threat model，不能在现有配置接口上增量塞入 Secret 字段。
- 原生组件契约改善一致性且不增加 bundle/runtime 依赖，但不会直接复用 shadcn 的 React
  实现；需要继续通过浏览器与可访问性测试维护行为一致性。
