# 02 AI SDK 执行 Registry 退役

> 状态：已完成
>
> 已确认边界：Adapter 创建 Model 时直接接收单个、已经完整性校验的 Registry Provider Config 和
> Registry Model Config；不得把旧执行 Registry 的字段、默认值、查询面、Provider 分类或同形执行 DTO
> 迁入新的业务 Registry。
>
> 日期：2026-08-24
>
> 总路线图：[`todo-00-model-abstraction-unification-roadmap.md`](./todo-00-model-abstraction-unification-roadmap.md)
>
> 相关设计：[`../design/registry/model-creation.md`](../design/registry/model-creation.md)

## 1. 任务目标

删除 Adapter 内部 `AiSdkModelRegistry` 对 Provider 配置的可变 Registry 语义，使业务 Provider Registry
成为唯一 Provider/Model 静态事实源。ModelFactory 在创建 Model 时把已经解析好的事实一次性传给 Adapter，
Adapter 返回封装 AI SDK 执行的 Model，不再反向按 ModelRef 查询另一份 Registry。

```text
当前

Business Provider Registry
        |
        +--> ApiProviderModelRuntime.modelFactory
        |
        `--> revision subscription
                 |
                 v
        AiSdkModelAdapter.replaceRegistryConfig
                 |
                 v
        mutable AiSdkModelRegistry
        |- providers map
        |- defaultProviderId
        |- resolve(ModelRef)
        |- bindModel(ModelRef)
        `- resolveConnection(ModelRef)

目标

Business Provider Registry
        |
        | ModelFactory create 时一次 lookup
        v
RegistryProviderConfig + RegistryModelConfig + ModelOptions
        |
        | 单次创建；不复制为第二套 Config
        v
Adapter.createModel(完整 Config + 明确执行依赖)
        |
        v
Model 闭包持有静态 AI SDK 执行事实
        |
        `--> request attempt 只解析动态 Request Auth
```

## 2. 核心裁决

### 2.1 退役的是 Registry，不是 AI SDK 执行能力

必须保留：

- 正式 `ProviderApiType` 当前声明的 Anthropic Messages、OpenAI Responses 和 OpenAI Chat Completions SDK
  执行能力；旧 `gateway/custom` 执行分类不能在没有正式 Config API type 的情况下迁入新抽象；
- API baseURL、静态 Header 和 API Key 投影；
- proxy、CA、no-proxy、Endpoint Routing；
- Client Request Signing 和必要的进程级 cache；
- request-auth 动态覆盖；
- Provider request body compatibility；
- Retry、Stream Recovery、Usage、Status、Telemetry 和错误归一化。

删除的是允许 Adapter 再次承担“当前有哪些 Provider、默认 Provider 是谁、按字符串解析哪个模型、返回什么
Connection”的业务查询面。

### 2.2 不用另一个名字保留同一结构

禁止把 `AiSdkModelRegistry` 原样改名为：

- `ExecutionModelRegistry`；
- `ExecutionModelBindingRegistry`；
- `ConnectionRegistry`；
- `Runtime Provider Registry`。

实现可以有 Adapter 私有参数类型、闭包和工厂 cache，但不能提供 Provider list、默认选择、ModelRef 解析、
可变配置替换或通用 Connection lookup。

### 2.3 Model 创建冻结静态事实

Model 创建时固定：

- providerId / modelId；
- API kind/type；
- baseURL；
- 静态 headers；
- 静态 API Key 或 account accessId；
- Provider options 映射；
- Model properties / optionSpecs / options；
- 本次执行需要的基础设施引用。

这里冻结的是静态执行事实和依赖引用，不是已经完成动态鉴权的最终 `LanguageModel`。Registry 后续更新不
改变已创建 Model；每个 request attempt 仍解析当前动态 Request Auth，并在 Retry 时取得刷新后的材料。
请求期 auth 只能覆盖被明确允许的动态 API Key/Header，不能改变 Endpoint、API kind、Provider options 或
模型能力。

旧 Registry 的 `apiKeyEnv`、`apiKeyRequired`、默认环境变量、`defaultProviderId`、裸 modelId 解析和
Connection lookup 一律删除，不进入业务 Provider Config、Registry、Model Config 或新的公共执行抽象。

### 2.4 Adapter 直接消费完整 Registry Config

Adapter 创建入口直接接收 Todo 03 完整性边界产出的同一个 `RegistryProviderConfig` 和
`RegistryModelConfig` 对象。不得先把它们复制或拆成 `AiSdkModelProviderConfig`、
`ExecutionProviderConfig`、`ExecutionModelConfig`、`ResolvedConnection` 或其他同形 DTO。

```text
Sparse Provider / Model Config
             |
             v
Overlay + resolve + validateComplete + requireComplete
             |
             v
RegistryProviderConfig + RegistryModelConfig
             |
             | 同一对象直接传递
             v
Adapter.createModel
```

Adapter 可以忽略 `label`、`visibility`、模型成员等非执行字段；“只消费其中一部分”不构成再声明一个
`Pick<>` 公共类型或复制执行投影的理由。`@zcode/adapters` 可以依赖纯领域包 `@zcode/provider` 的完整类型；
不得为了规避该依赖，把 Provider/Model Config 复制到 `@zcode/contracts`。

### 2.5 Config、绑定选项与执行依赖分工

完整 Config 之外只传递不能由 Config 表达的事实：

- `providerId`、`modelId`：它们是 Registry 索引键，不要求重复写入 Config 对象；
- `ModelOptions`：当前 Selection/`Model.bind()` 已绑定的执行值，不是 Model Config 声明；
- `ModelRequestDependencies`：本次执行作用域的动态 request-auth Source，不进入 Config；
- 进程级 runtime、network、proxy、CA、routing、signing、retry、logger、status/telemetry sink：由 Adapter
  构造器或其私有基础设施 Service 注入，不随每个 Provider/Model Config 重复传递。

`api-key` 的静态 Key 直接来自 `providerConfig.access`。账号型 Provider 固定 Config 中非 Secret 的
Account Access 快照，动态账号凭据按 attempt 解析；其结构化连接选择与 Access Context 的具体切换由
Todo 07 负责。本 Todo 不从 `accessId` 反解析账号事实，也不建立第二套鉴权 Config。

## 3. 目标接口形态

领域公开接口继续只有 `ModelFactory` 和 `Model`。Adapter 创建入口接收以下事实；实现可以使用对象参数，
但该对象只是函数参数，不是可查询、可持久化、可同步或可复用的业务 Config 类型：

```ts
adapter.createModel({
  providerId,
  modelId,
  providerConfig, // RegistryProviderConfig
  modelConfig, // RegistryModelConfig
  options,
  requestDependencies,
});
```

Adapter 从 `modelConfig` 直接取得 `properties`、`optionSpecs` 和 `reasoningMapping`，从 `providerConfig`
直接取得 `api`、`access` 和静态 Header。不要由 Bootstrap 提前拆字段，也不要让 Adapter 再做完整性校验、
模型成员判断、enabled 判断或 Config 默认值补齐。

Adapter 内部可以闭包捕获这两个完整 Config 引用，并为 AI SDK 创建短生命周期的私有调用参数；但不能保存
另一份 Provider map，也不能从 barrel 向 Core/Service/Protocol 导出新的执行 Config 类型。

进程级共享的 signing state、network transport、Endpoint Routing service、logger、runtime、status sink 等
继续由 Bootstrap 注入 Adapter。共享 cache 只缓存昂贵执行资源，不提供业务查询能力。

## 4. 删除与迁移范围

### 4.1 `AiSdkModelRegistry`

删除或拆解：

- `providers` 可变 map；
- `replaceConfig()`；
- `defaultProviderId`；
- `parseModelRef()` 依赖；
- `resolve()`；
- `bindModel()`；
- `resolveConnection()`；
- `AiSdkResolvedModelConnection`；
- 以 Provider/Model 查询为目的的 list/default helper；
- 将 `ModelProperties` 放入 Adapter Registry resolved value 的结构。

可抽成 Adapter 私有纯函数或执行服务：

- 单个 Provider Config 到 `LanguageModel` factory 的创建；
- 静态和动态 auth 的受控合并；
- transport 组合；
- signing manager 生命周期；
- Provider Business Error fetch 包装；
- SDK 模型实例 cache。

如果 cache key 需要 providerId/modelId/baseURL 等字段，它仍只是执行资源 cache；不得以 cache 内容回答业务
Provider/Model 查询。

### 4.2 `AiSdkModelAdapter`

删除：

- constructor 的 `registry` 参数；
- `replaceRegistryConfig()`；
- 旧 `generateText(AiSdkModelTextRequest)` / `streamText(...)` 若 Todo 01 尚未删除；
- `createModel()` 内的 `registry.bindModel(options.model)`；
- 对字符串 ModelRef/default Provider 的支持。

改为：

- `createModel()` 直接接收 providerId/modelId、完整 `RegistryProviderConfig`、完整
  `RegistryModelConfig`、绑定 options 和必要的执行依赖；
- `properties`、`optionSpecs`、`reasoningMapping`、API type、baseURL、静态 Header 和 Access 均从完整
  Config 读取，不再由 Bootstrap 逐字段投影；
- Model 闭包在每个 attempt 调用 request-auth source，并把结果投影到冻结的 Provider 执行事实；
- runner 在每个 request attempt 接收结合当次 Request Auth 后解析的 `LanguageModel`/执行参数，不再持有
  Registry；动态鉴权完成后的 `LanguageModel` 不在 Model 创建时冻结。

### 4.3 Bootstrap `ApiProviderModelRuntime`

删除：

- Registry revision subscription 仅用于 `#syncExecutionRegistry()` 的逻辑；
- `createApiProviderAiSdkRegistryConfig(view)` 全量复制；
- `#modelAdapter.replaceRegistryConfig(...)`；
- 把 Business Registry View 转成第二份 `providers` map 的代码。

保留或简化：

- `modelFactory` 从业务 Registry lookup Provider/Model；
- 完整性和 options 校验位于业务 Registry/ModelFactory 边界；
- 把单个完整 Provider/Model Config、绑定 options 和 request dependencies 直接交给 Adapter；
- visible output budget 等 Selection/执行作用域约束在调用 Adapter 前形成最终绑定 options。

若 `ApiProviderModelRuntime` 完成后只包装 `modelFactory`，可以进一步内联为 ModelFactory 创建函数；不要为保留
类名制造 start/subscription 生命周期。

### 4.4 旧 Bootstrap model-config

审计并缩小 `createAiSdkModelRegistryConfig()`、`createRuntimeAiSdkModelRegistryInfrastructure()`：

- Provider 列表和 default provider 不再进入 Adapter；
- 网络、签名、Endpoint Routing、runtime 和 env 等执行基础设施可以保留并改为准确命名；
- Probe/E2E helper 改为显式创建测试 Model，而不是先造一整个 Registry。

### 4.5 Reasoning 差异归入 ZCode Built-in Model Config Rules

所有正式模型和 API 类型的 Reasoning 差异事实统一由 ZCode Built-in Model Config Rules 声明：

- `optionSpecs.reasoningLevel.values/default` 声明公开档位；
- `reasoningMapping[level]` 声明该档位对应的 Provider 请求参数；
- `disabled`、`off`、`nothink`、`none` 等额外映射可以声明关闭推理的执行参数；
- Personal Model Config Rules 继续排在 Built-in Rules 之后并覆盖明确提供的配置。

Adapter 只执行正向映射：

```text
Model.options.reasoningLevel
             |
             v
modelConfig.reasoningMapping[level]
             |
             v
providerConfig.api.type 对应的协议编码
```

删除 `resolveReasoningDisabledProviderOptions()`、旧 Model Catalog 的请求装配职责，以及按 modelId、旧
Provider kind、任意 providerOptions 字段或 legacy `extra_body` 反向猜测档位的逻辑。迁入 Built-in Config
的是模型/API 差异事实，不是这些旧推断算法。

`runtime-thought-level` 当前还服务既有 Telemetry。本 Todo 不重构 Telemetry schema、Context 或上报通道；
只移除它对旧 Catalog、modelId hardcode 和旧 Provider 分类的依赖。能从本次 Model options 和明确映射得到的
观测继续记录，无法可靠得到的字段保持现有 unknown/缺省语义，不为遥测恢复反向猜测。

## 5. 与 Todo 03 的交叉边界

Todo 03 正在收紧 Registry Provider/Model 的完整类型。两项共同原则是：

```text
Sparse Rule -> resolve + validateComplete -> Complete Registry Model
                                          |
                                          v
                               Adapter.createModel
```

Todo 02 不应自行补能力默认值，也不应重复建立 `requireCompleteProperties()`。正式切换 Adapter 接口和删除
旧 Registry 必须基于 Todo 03 已合入的完整类型；在此之前可以先分类测试和识别可保留的执行基础设施，但不
引入临时完整类型或重复校验 helper。

## 6. 测试先行

### 6.1 生命周期

1. Model A 创建后更新业务 Registry，A 继续使用旧 API kind/baseURL/static headers；
2. 更新后创建 Model B，B 使用新事实；
3. 删除 Provider 后，已创建 A 可以完成当前请求，新创建失败；
4. Adapter 不再订阅或查询业务 Registry；
5. 不存在 defaultProviderId/裸 modelId fallback。

### 6.2 鉴权

1. api-key Model 使用创建时固定 Key；
2. zhipu-account Model 固定 accessId，每个 attempt 可以刷新动态凭据；
3. request-auth 无 Source/无材料时网络前失败；
4. Retry 可取得更新后的 auth；
5. 动态 auth 不能覆盖 baseURL、API kind、Provider options 或 properties；
6. Secret 不进入 ModelSelection、Session event、日志或 Registry View。

### 6.3 Provider 执行能力

按职责迁移旧 Registry tests，而不是一比一保留构造方式：

- 各 API 类型创建正确 AI SDK LanguageModel；
- proxy/CA/no-proxy 和 Endpoint Routing 组合不变；
- Signing gate/key cache 的隔离和生命周期不变；
- OpenAI Responses JSON compat、Anthropic stream compat 和 body compatibility 不变；
- Provider Business Error、TLS、Retry/Stream Recovery 归一化不变；
- generate/stream 共享同一静态执行事实。

### 6.4 Config 与 Reasoning

1. Adapter 接收的 Provider/Model Config 与 Registry 发布对象是同一引用，不经过同形执行 DTO；
2. Adapter 不补齐稀疏字段，不重新执行 enabled、成员或完整性判断；
3. reasoningLevel 只经 `reasoningMapping[level]` 正向生成请求参数；
4. Built-in 和 Personal Rule 后置覆盖形成的 Effective Mapping 均可执行；
5. disabled/off/nothink/none 使用明确 Mapping，不调用通用字段清洗或模型 hardcode；
6. 缺少公开 level Mapping 在 Registry 完整性边界失败，不进入 Adapter；
7. Telemetry 不因移除 Catalog 而增加 Context、Observation DTO 或新的反向推断。

### 6.5 机械边界

- 生产代码无 `new AiSdkModelRegistry`；
- 生产代码无 `replaceRegistryConfig` / `replaceConfig`；
- Adapter 公共入口不接受 `ModelRef | string`；
- 生产代码无 `AiSdkModelProviderConfig`、`AiSdkModelRegistryConfig` 或同形替代 DTO；
- Adapter 请求装配不导入旧 Model Catalog、`AiSdkProviderKind` 或 modelId reasoning hardcode；
- Core/Service/Protocol 不导入 Adapter 私有执行投影；
- `dep:refs` 和 `rg` 确认旧 Registry 查询方法无引用。

## 7. 实施顺序

### Step A：锁定行为测试

- 把旧 Registry tests 按“业务查询行为”与“执行基础设施行为”分类；
- 为 Model 静态事实冻结和 Request Auth 动态刷新增加失败测试；
- 明确每种 Provider API 的最小代表测试。

### Step B：建立单 Provider 执行创建路径

- 从 Registry class 提取纯 Provider factory/transport/signing 组合；
- 让 Adapter `createModel()` 直接接收完整 Registry Provider/Model Config；
- 删除 Bootstrap 对 API/access/properties/optionSpecs/reasoningMapping 的逐字段二次投影；
- runner 改为消费已经绑定的执行闭包。

### Step C：切换业务 ModelFactory

- `ApiProviderModelRuntime.modelFactory` 直接投影单个 Provider/Model；
- 删除全量 Registry sync/subscription；
- 验证旧 Model 与新 Registry revision 隔离。

### Step D：物理删除 Registry API

- 删除 `AiSdkModelRegistry`、Config 和 resolved connection 类型；
- 删除旧 Catalog/reasoning-disabled 的请求装配与反向推断；
- 迁移 Probe/E2E/test helper；
- 删除旧测试中只验证 defaultProvider/list/parse 的用例。

### Step E：验证与提交

- 运行 Adapter、Bootstrap、Core 受影响单测；
- 运行 `pnpm typecheck`、`pnpm lint`、`pnpm fmt:check`；
- 对 endpoint routing、request auth、stream/retry 运行代表 E2E/协议回归；
- 与已裁决并同步实施的 Todo 03 共同形成一个 Conventional Commit。

## 8. 完成定义

完成后，仓库中“Registry”只指业务 Provider Registry。Adapter 可以有执行资源 cache 和基础设施 service，
但不能再保存另一份 Provider 列表、解析 ModelSelection、提供 Connection 查询或响应配置热替换。每个 Model
直接持有创建瞬间的完整 Registry Provider/Model Config 和绑定 options；动态访问材料只在 request attempt
解析。Reasoning 请求参数只来自 Effective Model Config 的明确 Mapping，不再来自旧 Catalog、Provider kind
或 modelId 推断。

## 9. 实现结果

- Adapter 的可变 Provider map、默认 Provider、`resolve` / `bindModel` / `resolveConnection` 和热替换接口
  已删除；生产代码不再存在 `AiSdkModelRegistry`；
- `AiSdkModelAdapter.createModel()` 直接接收同一个 `RegistryProviderConfig` / `RegistryModelConfig` 引用，
  Model 闭包冻结创建时的静态事实，不建立同形执行 Config；
- Bootstrap 已删除业务 Registry revision 到 Adapter Registry 的全量同步与订阅，只在 ModelFactory 创建时
  lookup 单个 Provider/Model；
- request-auth 与账号动态凭据继续按 request attempt 解析，缺失材料在发起网络请求前失败；
- Provider SDK、代理、CA、Endpoint Routing、签名、Retry、Stream Recovery、Usage、Status 与错误归一化
  继续由 Adapter 私有执行基础设施承担；
- 旧 reasoning-disabled helper 与按 modelId/Provider 分类反向猜测的执行路径已删除，明确映射来自 Effective
  Model Config Rules；reasoning 关闭只使用明确的额外 Mapping key，缺失时不发送 reasoning 参数；
- Todo 02 与 Todo 03 作为同一条事实链共同实现并提交，没有人为拆成两个相互依赖的提交。
