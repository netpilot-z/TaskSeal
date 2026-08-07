# ADR 0023：Provider 坐标按 operation revision 激活

## 状态

Accepted，2026-08-07。

## 背景

Provider 的仓库、workspace、team、project、状态和 enablement 坐标属于一次
Provider operation 的输入，不应因为用户保存了新的坐标就漂移正在进行的外部动作。
此前 Configuration Control 将所有 project 字段标记为 restart-required，导致修改
连接坐标后必须人工重启 Control Room，反馈慢且容易把配置保存和运行时生存期混为一谈。

## 决策

1. `project`、`mode`、`runtime.port`、存储和 runner 能力仍然是 process-bound，继续要求
   重启或 supervisor handoff。
2. GitHub、Linear、飞书和 Gitee 的非 Secret provider 坐标与 enablement 是
   operation-bound。配置写入通过既有 revision/CAS/原子替换后，下一次 operation 在
   admission 时读取新的配置 revision；已经开始的 operation 继续使用它创建时绑定的
   snapshot。
3. Secret 仍只通过环境绑定或未来的 OS keychain/Vault resolver 读取；浏览器、配置文件、
   journal 和错误响应不保存 Secret 值。
4. Provider observation 页面只做只读状态展示；普通加载和保存不触网，显式 probe 才能
   发起有界的外部读取。
5. 若 provider adapter 尚未实现 operation-bound 解析，必须将其 capability 标为不可用，
   不得把“已保存”冒充“已激活”。

## 后果

- Connections 可以显示“下一次 operation 生效”，并将进程级重启提示限制到真正的
  process-bound 字段。
- Linear acceptance 使用按 operation 缓存的 transition adapter，防止 prepare、approve、
  submit 之间发生配置漂移；后续 provider adapter 必须复用同一 seam。
- 外部 OAuth、token rotation、OS Secret Vault 和自动 supervisor 重启仍不在本 ADR
  范围内，缺少注册应用或安全存储时只能显示官方设置入口和凭据存在性。
