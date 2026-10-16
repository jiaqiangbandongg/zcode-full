# Account Provider 的配置、访问范围与请求鉴权

> 调查日期：2026-08-17
>
> 适用范围：M2 Account Access Source 与后续 ModelFactory 的边界设计
>
> 文档身份：历史现状调研。Account Config、请求期鉴权和 Remote Environment 权威边界已经由
> [`../steps/02-provider-config-and-registry-human-in-the-loop.md`](../steps/02-provider-config-and-registry-human-in-the-loop.md)
> 裁决，并进入当前 Design 与 M2 实现；正文保留调查当时的上下文。

本文梳理现有 Start Plan、Personal Coding Plan 与 Team Plan 链路中的事实归属。它记录现状与迁移边界，不改变当前 Provider Family 的选择行为。

## 结论

现有实现把三类生命周期不同的数据装进同一份 Provider Registry Snapshot：

```text
Provider / Model 静态定义
        +
账号与套餐允许范围
        +
JWT / Runtime API Key / 一次性安全校验 Header
        |
        v
旧 ZCodeProviderRegistrySnapshot
```

新链路需要按事实生命周期拆开：

```text
Official Config
├─ Account Provider 的 providerId、label、apiFormat、baseURL
├─ Provider 声明的模型全集与顺序
└─ Model Properties、Option Specs 与 reasoning mapping

Account Access
├─ 当前账号实际允许发布的 Account Provider
├─ 每个 Provider 当前允许发布的 modelId
└─ 创建 Model 时必须固定的非敏感账号访问身份

Request Auth
├─ 登录 Token / JWT
├─ Personal Coding Plan API Key
├─ Team Project Runtime API Key
├─ 一次性安全校验 Header
└─ 失败后的刷新与重试策略
```

Registry 只组合前两类事实。请求期鉴权不进入 Registry，也不序列化给 Renderer。

## 为什么 Account Access 还需要访问身份

当前 Personal Coding Plan 和 Team Plan 可以共用同一个 `providerId`。如果 Model 只保存 `providerId + modelId`，每次请求再读取“当前选中的连接”，会出现下面的时序：

```text
Loop A 创建 Model
└─ 当时选择 Personal Coding Plan

用户切换到 Team Plan
└─ Account Service 的当前连接发生变化

Loop A 的下一次请求
└─ 如果只按 providerId 取凭据，会静默改用 Team Plan
```

这违反已经确定的 Model 生命周期：同一段连续执行持有的模型身份与执行配置保持稳定。因此 Account Access 发布给 Registry 的条目需要包含一个可固定的访问身份。它只定位“向哪一个账号/套餐连接索取请求凭据”，不包含 Secret。

M2 使用如下语义：

```ts
interface AccountProviderAccessEntry {
  providerId: ProviderId;
  modelIds: readonly ModelId[];
  accessId: string;
}
```

ModelFactory 创建 Model 时复制 `accessId`。每次模型请求由 Request Auth Service 使用该 ID 取得当前有效凭据。Token 刷新可以影响下一次请求，但不能把 Personal 连接换成 Team 连接，也不能更换 Provider 或 Model。

## 当前 Family 行为

`filterResolvedProviderFamiliesForRegistry()` 当前会在 Z.ai 和 BigModel 两个 Family 中各挑选一个生效 Provider：

```text
API Key mode
└─ API Provider

OAuth mode
├─ 已选 Team Plan -> Coding Plan Provider
├─ Personal Coding Plan 可用 -> Coding Plan Provider
└─ 否则 -> Start Plan Provider
```

这项行为同时承担产品选择和旧 Registry 去重。M2 当前不改变该行为。Account Access Source 应先投影同样的“当前生效 Provider + 模型范围”，再由后续独立设计判断是否允许同一 Family 同时发布多个连接。

## 静态模型事实的现状

现有静态事实来自多个位置：

- `/client/configs` 提供远端 Provider、模型和 Schema。
- `presetModelDefaults.ts` 提供 GLM Provider 的 fallback 模型集合。
- `modelProviderServiceStorage.ts` 提供 fallback Provider、Endpoint 和模型。
- `model-provider-types.ts` 保存 Start Plan 免费模型与 reasoning 特例。
- China LLM Catalog 与运行时代码继续补充 Properties、Option Specs 和 Provider Options Patch。

这些来源在目标设计中不能继续独立参与 Registry。稳定事实需要迁入 Official Config；账号接口返回的可用模型 ID 只作为 Account Access 的过滤范围。

Start Plan 当前是最清楚的例子：`billing/balance` 返回套餐允许的模型 ID，`client/configs.builtinModels` 为这些 ID 补充模型事实。新设计中，Official Config 应维护模型事实全集，Balance 只返回当前可用子集。Balance 与 Official 暂时不一致时，需要在 Account Source 明确采用 last-known-good 或报告配置不一致，不能在 Registry 临时创造只有 modelId 的半完整模型。

## Endpoint 与产品环境

Account Provider Endpoint 目前存在生产、测试等环境分支。例如 Z.ai Coding Plan 使用 `resolveZaiBusinessBaseUrl(process.env)`，Start Plan 使用当前 ZCode Endpoint 派生出的 zcode-plan 网关。

Official Config 成为唯一事实源后，Registry 和 Provider Factory 不能再次用 `process.env` 改写这些字段。每个产品环境应取得一份已经完整解析的 Official Config：

```text
Production Official Config
└─ production endpoints

Test Official Config
└─ test endpoints

Dev / injected Official Config
└─ local or developer endpoints
```

它们使用相同 Schema，可以由发布服务按环境生成；运行时 Source 仍只读取一份完整文档。这样环境选择属于 Official Config 的发布和注入，不成为 Registry 的第四个事实来源。

## 请求鉴权现状

三类 Plan 的请求凭据不同：

```text
Start Plan
├─ 登录产生的 zcode JWT
└─ 请求 attempt 前取得一次性安全校验 Header

Personal Coding Plan
├─ OAuth access token 用于查询账号与套餐
└─ 通过业务接口创建或复制模型调用 API Key

Team Plan
├─ 选中的 organization / project
└─ 为该项目创建或复制 Runtime API Key
```

旧实现有时把复制出的 Key 或 JWT 写入/投影为 Provider `apiKey`。新 Account Access Source 不得沿用这种形态。Request Auth Service 需要按固定的访问身份获取请求材料，并自行处理缓存、刷新和鉴权失败后的强制刷新；这些策略不会改变 Registry View。

## 实施前仍需裁决

Account Access Source 的实现需要先确定一项产品语义：

```text
方案 A：每个 Provider Family 只发布当前生效的一个连接
方案 B：同时发布多个可用连接，并让 ModelSelection 包含连接身份
```

方案 A 保持当前行为，也保持 `providerId + modelId + options` 足以表达 Selection。方案 B 会扩大选择器、Session 持久化、Submission 协议和 Model 身份边界。M2 采用方案 A；无论未来是否扩展，Model 都必须固定创建时的 `accessId`，避免运行中随全局选择漂移。
