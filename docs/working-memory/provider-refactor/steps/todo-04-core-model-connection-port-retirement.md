# 04 Core Model Connection Port 退役

> 状态：已完成
>
> 日期：2026-08-24
>
> 总路线图：[`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)
>
> 前置任务：[`todo-02-ai-sdk-execution-registry-retirement.md`](./todo-02-ai-sdk-execution-registry-retirement.md)、
> [`todo-03-provider-model-ownership-and-property-totality.md`](./todo-03-provider-model-ownership-and-property-totality.md)

## 1. 任务目标

从 Core 和公共业务 Contract 删除 `ModelConnectionPort` / `ModelConnectionInfo`。Core 的能力判断统一读取当前
Active Model 的 `properties`；API Key、Header、baseURL、Provider SDK kind 和 providerOptions 等物理连接
事实只存在于 Adapter 的请求执行实现。

```text
当前

Core Runtime / Tool
  |- Active Model.properties
  `- ModelConnectionPort.resolveConnection(ModelRef)
       |- apiKey / headers
       |- baseURL / providerKind
       `- providerOptions
             |
             `--> Core 再次推断 WebSearch / MCS / diagnostics

目标

Core Runtime / Tool
  `- Active Model.properties
       |- supportsNativeWebSearch
       `- supportsMidConversationSystem

Adapter private execution
  `- baseURL / SDK kind / credentials / headers / providerOptions
```

## 2. 核心原则

1. 模型能力是 Effective Model Config 的静态事实，只能从 Active Model.properties 读取；
2. 产生能力事实的 Model Config Rule 可以按模型、Provider、API 类型等解析上下文组合匹配，但 Core
   不根据 Endpoint、Provider 类型或具体 modelId 再次推断能力；
3. Connection 是 Adapter 请求实现细节，不是 Tool/Runtime 的查询服务；
4. API Key 和 Header 不应为了能力判断进入 Core；
5. 本 Todo 不重构 Telemetry，不新增脱敏 Connection、Observation 或 Context DTO；
6. 若 Adapter 内部仍需连接参数，使用私有类型，不能从 `@zcode/contracts` 导出。

## 3. 当前消费者与目标处理

### 3.1 Mid-conversation System

当前 `mid-conversation-system.ts` 通过 `providerKind + baseURL + modelId hardcode` 推断 MCS，并构造一份脱敏
Connection Context。目标改为：

```text
Active Model.properties.supportsMidConversationSystem
        +
execution override.mode = force
        |
        v
useMidConversationSystem
```

- 最终公式固定为 `mode === "force" || model.properties.supportsMidConversationSystem`；
- `auto` 直接读取 property；`force` 是本次调用覆盖，不修改 Model properties，也不进入 Model Config；
- 判断发生在生成本次 Provider messages 的调用位置；`midConversationSystemMode` 不进入 ModelFactory；
- 删除 fast model ID、baseURL allowlist、provider kind 和 Connection resolve fallback；
- 决策结果只保留业务需要的 boolean/reason，不携带 Connection；
- Model Config Rule 承担不同模型和接入组合的事实声明。

### 3.2 Native WebSearch

当前 WebSearch 先解析 Connection，再按 Anthropic/provider endpoint 判断支持。目标改为：

- Tool 从当前 Model 读取 `properties.supportsNativeWebSearch`；
- false 时返回现有可恢复配置错误；
- true 时继续由 Adapter 编码 Provider native tool；
- Adapter 只根据完整 Provider Config 的 `api.type` 选择编码实现，不根据 baseURL allowlist 推断能力；
- Adapter 若该 API 类型无法编码，必须在网络请求前抛出类型化 `InvalidModelRequest`，不能返回
  `undefined` 后静默删除 Tool，也不能因 Config 绕过实现限制；
- generate 与 stream 共用同一编码和 fail-closed 路径；
- 删除 Core `resolveWebSearchModelConnection()`、`supportsProviderNativeWebSearch(connection)` 和 Connection
  诊断字段。

### 3.2.1 Model Config 能力规则

`supportsNativeWebSearch` 和 `supportsMidConversationSystem` 统一写入 ZCode Built-in / Personal Model
Config Rules，最终成为 Effective Model Config.properties。配置归属在 Model Config，不等于规则只能按
modelId 匹配：

```text
Model Config Rule resolve context
|- providerId
|- modelId
`- provider.api.type
          |
          v
Effective Model Config.properties
|- supportsNativeWebSearch
`- supportsMidConversationSystem
```

- 能力对模型普遍成立时，只使用 `modelMatch`；
- 能力仅在特定产品 Provider 中成立时，组合 `modelMatch + providerMatch`；
- 能力取决于协议接入形态时，组合 `modelMatch + apiMatch`；
- 如果未来确需按 Endpoint 部署区分，应扩展 Model Rule 的声明式解析上下文，不能把 URL 判断重新放回
  Runtime、Core、Importer 或 Adapter；
- Built-in 通用 Rule 提供完整保守默认值，后续精确 Rule 覆盖真实差异；
- 具体能力值以模型和服务的真实支持资料为依据，不从旧 hostname allowlist 机械翻译；
- Legacy importer 只迁移旧配置明确表达的事实；没有明确事实时不按 Provider kind、baseURL 或 modelId
  猜测并固化能力。

### 3.3 Embedded Search

当前 Embedded Search 的最终开关只依赖 global flag 与 Bash availability，Connection 只用于构造诊断
context。目标是直接删除 Connection/ModelRef 上下文：

```text
embeddedSearchBranchEnabled + bashAvailable -> decision
```

不为保留诊断对象继续传递 baseURL/providerKind/modelId。

### 3.4 Tool/Runtime Context

删除以下公共字段和透传：

- `AgentRuntimeDeps.modelConnectionPort`；
- `AgentRuntime` / `AgentRuntimeInternal.modelConnectionPort`；
- `ToolExecutionContext.modelConnectionPort`；
- Tool executor、Child Runtime、Workflow 对 Port 的复制；
- `modelRef + modelConnectionPort` 只为能力判断而存在的组合参数。

需要当前模型能力的调用点接收或访问当前 `Model`。不要拆出另一份 `ModelCapabilities` 或 Connection-aware
context。

Tool 获取分成两种明确语义：

```text
Tool Registry
|- 非执行 inventory -> 返回已注册 Tool，不需要 Model
`- 本次请求工具集 -> 必须接收当前 Active Model，再按 properties 过滤
```

- 持久化兼容字段、Context guidance、Plugin inventory 等非执行用途直接读取 Tool Registry；
- 真正进入主请求、Compact、Memory 或 Child Agent 执行时，必须使用该执行自己的 Active Model；
- Child Agent 的模型可能不同，父级只传注册 Tool inventory，Child Runtime 再按自己的 Active Model 过滤；
- 不允许从 Session Selection 或 Connection 构造兜底 Model、默认 Model或假 Model。

### 3.5 Contracts 与 Adapter

删除公共：

- `model-connection.port.ts`；
- `ModelConnectionProviderKind`；
- `ModelConnectionInfo`；
- `ModelConnectionPort`；
- barrel exports；
- `AiSdkModelAdapter.resolveConnection()`；
- `AiSdkResolvedModelConnection`。

Adapter 内部执行函数如果需要 `baseURL/providerKind/apiKey/headers/providerOptions`，定义为局部或 Adapter
私有类型。它不能被 Core、Bootstrap 业务层或 Tool 导入。

## 4. Telemetry 边界

当前网络 Status/Telemetry 自己已经持有 providerId、model、baseURL、providerKind 等字段。本 Todo 不判断
这套设计是否合理，也不通过 Connection Port 重构它。

允许：删除 Port 后，Adapter 在现有网络事件产生位置继续用自己已知的执行事实填充现有字段。

禁止：

- 新增 `TelemetryContext`；
- 新增 `ModelTelemetryObservation`；
- 把完整 Connection 作为 event payload；
- 为 Telemetry 让 Core 继续持有 Connection；
- 顺手拆分 Product Status 与 Telemetry。

Telemetry 的长期设计另行讨论。

## 5. 测试先行

### 5.1 能力事实

1. `supportsMidConversationSystem=true/false` 分别启用/关闭 MCS；
2. MCS `force` 保持既有覆盖语义；
3. 不同 modelId/baseURL 但相同 property 得到相同 Core 行为；
4. `supportsNativeWebSearch=true/false` 分别允许/拒绝 WebSearch；
5. Adapter 不支持的 API 类型即使 property=true 仍在网络请求前 fail-closed，generate/stream 行为一致；
6. Embedded Search 只由 feature flag 与 Bash availability 决定。

### 5.2 数据边界

1. Core/Tool context 不出现 apiKey、headers、baseURL、providerKind、providerOptions；
2. Active Model.properties 是能力判断的唯一输入；
3. Main、Compact、Subagent 使用各自当前 Active Model 的 properties；
4. Config 更新不改变已开始 Loop 的能力；
5. 非执行 Tool inventory 不创建 Model；执行 Tool 过滤必须持有当前 Active Model；
6. 现有网络 Status/Telemetry 仍由 Adapter 发出，不改变事件数量和时机。

### 5.3 机械归零

- `rg 'ModelConnectionPort|ModelConnectionInfo' apps/zcode-cli/packages/core` 为零；
- 公共 Contracts 不再导出 Connection 类型；
- `resolveConnection` 不再是 Adapter 公共能力；
- Core 中按 baseURL/providerKind/modelId 判断 MCS/WebSearch 的 helper 为零；
- Legacy importer 中按 baseURL/providerKind/modelId 猜测 MCS/WebSearch 的逻辑为零；
- Provider-native Tool 编码不再用 `undefined` 表示“不支持并静默删除”；
- 不新增 `*Capabilities`、`*ConnectionContext` 或 `*Observation` 替代 DTO。

## 6. 实施顺序

### Step A：给 capability consumer 传递 Active Model

- 为 MCS、WebSearch、Embedded Search 增加 property-based 失败测试；
- 梳理 Tool context 当前 Model 的来源；
- 只传 Model，不传 Connection 或派生 capability snapshot。

### Step B：迁移能力判断

- MCS 改读 `supportsMidConversationSystem`；
- WebSearch 改读 `supportsNativeWebSearch`；
- Embedded Search 删除无作用的 Connection context；
- 删除旧 Endpoint/model hardcode 和 fallback reason。

### Step C：删除 Port

- 删除 Runtime/Tool/Workflow 字段和透传；
- 删除 Contracts 文件和 barrel export；
- 删除 Adapter 公共 `resolveConnection()`；
- 保留 Adapter 私有执行事实。

### Step D：验证与提交

- 运行 Core WebSearch、MCS、Embedded Search、Compact、Subagent 单测；
- 运行 Adapter 编码和网络事件回归；
- 运行 `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`；
- 独立 Conventional Commit。

## 7. 完成定义

Core 无法取得物理 Provider Connection，也不再通过 Connection 推断模型能力。业务能力来自当前 Active
Model.properties；连接、鉴权和 Provider SDK 细节只在 Adapter 执行请求时使用。Telemetry 保持现有设计，
没有为了本次删除产生新的 Context 或 Observation 抽象。
