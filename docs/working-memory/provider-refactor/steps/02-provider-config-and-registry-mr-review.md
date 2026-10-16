# M2 Merge Request 静态审查

> 状态：上线前问题已经逐项收口；已修复项以表格状态、正文和实施日志为准
>
> 日期：2026-08-20
>
> 审查基线：最初问题发现于 `origin/staging` `cf009a3b199c`；最终状态以 M2 Cleanup 与 Implementation Log 为准
>
> 阶段目标：[`02-provider-config-and-registry.md`](./02-provider-config-and-registry.md)

本文记录 M2 Merge Request 全量静态审查中发现的问题、已经确认的修复，以及仍需后续讨论的边界。它不修改 Design；涉及新产品语义或架构边界的事项仍需逐项讨论。

最初问题来自全量静态审查，后续修复均补充了对应失败测试和定向回归。最终全量校验及基线失败证据
记录在实施日志第 251 项。

## 当前判断

| 编号 | 问题 | 当前理解 | 状态 |
| --- | --- | --- | --- |
| R1 | 设置页曾经过共享旧 `ModelProviderConfig` 双向转换 | Renderer 编辑态已经改为正式 Config 同源 View；旧 Store 字段与反向转换退出设置页 | 已收口 |
| R2 | 新建自定义 Provider 要求已有 Settings View | 新建时允许缺少继承 View，并直接从完整表单 Draft 保存；编辑现有 Provider 继续复用 View | 已修复 |
| R3 | Account Access 可能进入 Personal Config | Personal 投影忽略 Account Overlay 注入的动态 `accessId`，继续保持 Official、Personal、Account 三层事实边界 | 已修复 |
| R4 | `reasoningMapping` 差异与整体 Overlay 语义冲突 | Mapping 变化时保存完整字段，与普通值字段的整体覆盖规则一致 | 已修复 |
| R5 | 请求鉴权刷新重新进入 Registry | Model 创建时固定 Provider 静态执行快照；请求鉴权只覆盖该快照的 API Key 与 Header | 已修复 |
| R6 | 登出与重新登录可能复用旧 Coding Plan Key | OAuth 清理前捕获账号身份并删除账号作用域 Key；重新登录强制根据新 Token 刷新 Key | 已修复 |
| R7 | 设置保存可能覆盖并发 Personal Config 修改 | Effective 保存已经移入 Repository 的原子 `update()`，锁内只修改目标 Provider 与对应精确模型规则 | 已修复 |
| R8 | Account 刷新失败可能遗留未消费的 pending reason | 失败轮释放 in-flight 后会自动继续消费期间到达的事件；上一份成功快照保持不变 | 已修复 |
| R9 | Connectivity 测试仍调用旧 Probe 参数 | 生产“测试连接”继续保留；专项测试已迁移到正式 Provider/Model Config 请求形状 | 已修复 |
| R10 | Remote Workspace 曾混合远端模型事实与本地账号服务 | Remote Host/Worker 已使用远端自己的 Config、Credential、Account Source 与 Registry；Desktop 不再下发 Provider/Secret | 已收口；Provisioning Sync 属于 M7 |

## 设置编辑链路

设置页面通过 Renderer 私有编辑态完成一次编辑会话。编辑态直接使用正式 Config 的字段结构：

```text
ProviderSettingsView
        |
        v
ProviderSettingsFormProvider
├─ providerId + Registry 投影状态
├─ config: ProviderConfigObject
└─ models: { modelId, config: ModelConfigObject }[]
        |
        | 用户编辑
        v
ProviderConfigObject / ModelConfigObject
        |
        v
相对 Official Config 投影 Personal Config
```

相关代码集中在：

- `packages/ui/src/lib/providerSettingsFormProjection.ts`；
- `packages/ui/src/lib/providerPersonalSave.ts`；
- `packages/ui/src/hooks/useModelProviders.ts`。

编辑态只表达设置页当前可编辑的交互状态，不作为物理存储、Registry 或模型执行契约。字段结构与正式
Config 同源，Renderer 不再维护 endpoints、kind、modalities、ProviderOptionsPatch 等旧 Store 语义。
保存完整 Effective Config 后，Facade/Repository 仍负责相对 Official Config 计算稀疏 Personal Overlay。

新建 Provider 的即时阻断已经独立修复。新 `providerId` 尚未进入 Registry，因此当前 Settings View 中
天然没有对应项；保存与连接测试直接从新建表单的完整 Provider/Model Draft 构造 Effective Config。
编辑已有 Provider 时，Renderer 从 Settings View 复制完整 Effective Config，用户可见控件只修改对应字段，
未暴露字段因此原样保留。Account 动态 Access 的 Personal 投影也已在领域层隔离。

如果未来需要在控件中区分继承值和显式 Personal 值，再把编辑态升级为 Personal Draft：

```text
ProviderSettingsView
├─ effectiveConfig：渲染最终效果
├─ personalConfig：用户显式 Overlay
└─ inherited/default：输入控件的继承提示
        |
        v
Personal Provider Draft
        |
        v
针对目标 Provider 的 Personal Config 写入
```

这属于设置交互的后续增强，不影响本轮删除旧字段双轨。当前编辑态不读取物理配置、不构建 Registry、
不决定模型可选性，也不创建 Model。

## Model Config 投影

设置页当前只直接编辑 Model ID、Context Window 和 Max Output Tokens，没有新增 Reasoning Mapping 编辑控件。编辑态保留完整 `ModelConfigObject`，因此用户修改其他字段时无需把 Reasoning Mapping 转成旧 Patch 再还原：

```text
ModelConfigObject.reasoningMapping
        |
        | 其他字段原位编辑
        v
ModelConfigObject.reasoningMapping
```

`ModelConfig.overlay()` 把 `reasoningMapping` 作为普通值整体覆盖。Personal Config 投影继续遵循相同规则：Mapping 没有变化时不写 Personal 字段；发生变化时保存完整 Mapping。

## Model 与请求鉴权边界

Account Request Auth Service 负责取得请求期 API Key 和 Header。静态审查发现，Adapter 曾在拿到
`ModelRequestAuth` 后再次调用当前 AI SDK Registry 的完整 `resolve()`：

```text
已绑定 Model
        |
        | 请求前刷新鉴权
        v
Account Request Auth Service
        |
        v
ModelRequestAuth
        |
        v
当前 Registry 完整 resolve(providerId, modelId)
```

这会让 Registry 更新后的同一个 Loop 重新取得 Endpoint、API Format、Provider Factory、Headers 或
Provider Options。修复后，`bindModel()` 在 Model 创建时捕获 Provider 静态执行配置和 Model 能力；
请求 attempt 只在这份快照上合并动态 API Key/Header，再创建当次 SDK Model。Registry 的后续热更新
只影响以后创建的 Model。

物理网络路由、代理和签名基础设施仍属于 Adapter 的动态请求设施；它们可以按自身生命周期更新，但不会
改变 Model 固定的 Provider 身份、协议、Endpoint、Provider Options 或静态 Header。测试覆盖了 Registry
热替换后旧 Model 继续使用原 Provider Factory 与静态 Header，同时接收最新请求鉴权材料的时序。

## Account Credential 生命周期

新 Personal Coding Plan Key 使用带账号身份的 Access ID：

```text
coding-plan:<provider>:account:<accountIdentity>
```

旧登出处理只删除无账号作用域的：

```text
coding-plan:<provider>
```

OAuth Session 又在 Logout Handler 执行前清除，因此 Handler 无法取得退出账号的身份。修复后，OAuth
Service 在清理主会话前读取当前 Profile ID，并把它随 Provider ID 传给 Logout Handler。Handler 删除准确的
账号作用域 Key，同时在兼容窗口内继续清理无账号作用域旧 Key。显式 logout、unlink、过期 JWT 失效和
logout-all 都沿用这条身份传递链；凭据损坏恢复无法可靠取得身份时，仍至少清理旧 Key，并由 Account
Source 下线 Provider。

重新登录的正确性已经独立修复：Renderer 登录完成后实际发出的 `oauth-login-entitlement` 现在会触发
`forceCredentialRefresh`，同一账号再次登录也会跳过旧缓存，使用新 OAuth Token 重新取得并覆盖 Coding
Plan Key。历史 `oauth-callback` 刷新仍兼容。

重新登录的强制刷新和登出的精确删除共同关闭了旧 Coding Plan Key 复用窗口。更长期仍可以使用结构化
刷新参数表达 `forceRefreshCredentials`，退出对 reason 字符串的解释；这属于接口整洁度，不再影响当前
凭据生命周期正确性。

## Personal Config 并发写入

`PersonalProviderConfigRepository.update()` 已经提供跨进程文件锁和锁内 read-modify-write。问题出在普通设置保存把旧 Registry 快照计算成整份 Personal Config，再通过 `replacePersonalConfig()` 忽略锁内读取到的最新内容。

普通保存现在保留现有锁，并在锁内完成目标更新：

```text
获得文件锁
        |
        v
读取最新 Personal Config
        |
        v
只修改目标 providerId 和对应精确模型
        |
        v
原子写回并释放锁
```

`ProviderSettingsFacade` 将 Effective Provider 和精确模型配置交给 `ProviderConfigService`；Service 在 Repository `update()` 中读取最新 Personal Config、计算相对 Official 的投影，并只替换目标 `providerId` 及其精确模型规则。Pattern 规则和其他 Provider 的并发更新保持不变。全量替换只用于版本迁移和明确的全量导入。

## Account 刷新时序

当前刷新循环会在一次解析失败时抛错并退出。若新刷新事件在解析等待期间到达，它会留在 `pendingReasons` 中，但 `finishRefresh()` 只清空 in-flight 标记，不会启动下一轮：

```text
刷新 A 进行中
        |
        +-- 新事件 B 进入 pending
        |
        v
A 失败并退出循环
        |
        v
B 无执行者
```

实现现在会在当前 in-flight 结束后检查 pending；若仍有事件，自动启动下一轮。A 的调用方仍然收到
失败，上一份成功快照继续保留。专项测试覆盖了“刷新 A 阻塞、事件 B 到达、A 失败、B 继续发布新快照”
的完整时序。

## Connectivity

Provider Connectivity 仍是实际产品能力。设置页的模型行提供测试连接入口，经过 `IProviderSettingsService.testModelConnectivity()` 调用新的 Config 与 Account Request Auth 链路。

过时的是 `packages/services/test/modelProviderConnectivityProbe.test.ts` 中三个直接调用，它们仍传入旧的
`endpoints/model/provider`，而生产 Probe 已接收 `baseURL/modelId/modelConfig/providerId`。这些测试现已
迁移到正式输入，继续覆盖请求 URL、Header、Reasoning Mapping 和协议请求体。Connectivity 产品能力
与生产实现没有在本轮改变。

## 审查后的阶段边界

本次审查发现的执行正确性和上线阻断项已经收口。设置页随后已直接使用正式 Config/View，Renderer
内部旧表单 DTO 也已删除，见 Implementation Log 第 281 节。

剩余工作只有 M7 的独立产品能力：本地到远端的 Provisioning Sync 与远端设置操作。远端 Registry
的事实权威保持在远端；该能力不会恢复 Host Snapshot 或改变 M2 的 Provider 事实链路。
