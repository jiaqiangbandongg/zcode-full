# Model 与 ModelRequest

业务代码通过 Model 发起模型请求。调用方只选择模型、准备 messages/tools/schema 和本次通用 Options，不读取 Provider 凭据、Endpoint 或协议参数。

```ts
const model = modelFactory({
  providerId: "zai",
  modelId: "glm-5",
  options: { reasoningLevel: "high" },
});

const result = await model.generateText({
  messages,
  tools,
});
```

主 Agent、Subagent、Automatic Compact、Title、Goal、Project Memory、Git、Repo Wiki、WebFetch、WebSearch 和其他模型任务都使用这条调用边界。

## Model 表达什么

Model 是已经确定 Provider、模型配置和通用 Options 的可调用对象：

```ts
interface Model {
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
  readonly properties: ModelProperties;
  readonly optionSpecs: ModelOptionSpecs;
  readonly options: ModelOptions;

  bind(options?: ModelOptions): Model;

  generateText(request: ModelRequest): Promise<ModelResult>;
  streamText(request: ModelRequest): AsyncIterable<ModelEvent>;
}
```

`providerId` 和 `modelId` 提供稳定身份；`properties`、`optionSpecs` 与 `options` 是 ModelFactory 在创建时
固定的完整执行事实。完整 `RegistryProviderConfig/RegistryModelConfig` 只作为 ModelFactory 交给 Adapter 的
私有创建输入，不从公共 Model 暴露。Model 不接受稀疏 Overlay Config，也不在执行期补齐 Properties。

Model 创建后不可变，并允许并发调用。Provider Config 或 Registry 更新不会修改现有 Model；新的执行通过
ModelFactory 基于当前 Registry 创建新 Model。

`bind(options)` 在同一 Provider 和模型上派生另一份不可变 Model。它主要服务 Agent Loop、Subagent 或独立任务固定自己的 Options。实现可以复用底层执行器和长期 Service，不要求重新创建 HTTP Client 或 Provider SDK 基础设施。

## 一次 Request

ModelRequest 只描述本次调用：

```ts
interface ModelRequest {
  messages: ModelMessage[];
  tools?: ModelTool[];
  responseJsonSchema?: JsonSchema;
  options?: ModelOptions;
  abortSignal?: AbortSignal;
}
```

请求的有效 Options 按以下顺序形成：

```text
Model Options
        |
        | Request 本次调用值覆盖
        v
Effective Request Options
```

Request Options 只影响这次调用，不修改 Model。Compact 等任务如果希望更小的输出上限，应在构造 Request 时明确提供 `maxOutputTokens`；Model 负责校验，不静默替调用方 clamp。

Request 不携带 providerId、modelId、API Key、Endpoint、Adapter kind 或任意 `providerOptions`。这些内容已经由 Model 的执行实现确定。

Properties、Option Specs、Options 合并和 Request 校验见 [`contract.md`](./contract.md)。

## 从 Model 到 Provider API

```text
ModelRequest
      |
      | merge options + validate
      v
Provider-neutral effective request
      |
      v
Provider Adapter
├─ 协议字段转换
├─ per-option 原始 Request Body Patch
├─ 动态 Token / Header
├─ 路由与重试
└─ 错误归一
      |
      v
Provider API
```

业务调用方不理解不同 Provider 的字段形状。普通 API Key 可以来自 Model 创建时的 ProviderConfig；Account Provider 的动态鉴权由请求时 Service 提供。完整边界见 [`../registry/model-creation.md`](../registry/model-creation.md)。

Temperature、top-p、top-k、penalty 和 seed 不进入公共 ModelRequest。新的通用 Option 需要先形成固定 Schema、Option Spec 和跨 Adapter 语义，不能通过任意 Record 向业务层开放。Option Map 的受限 CEL 与最终请求体边界见 [`model-option-map.md`](./model-option-map.md)。

## Model 生命周期

Session 持久化完整 ModelSelection：模型身份固定；支持 Reasoning 的模型同时保存具体档位。执行开始时，
Registry/ModelFactory 校验并冻结 Selection 已明确的 Option；单次输出预算由具体执行调用方提供：

```text
Session ModelSelection
        |
        | ModelFactory(selection)
        v
Agent Loop Active Model
├─ Step 1
├─ Tool Calls
├─ Step 2
├─ Automatic Compact
└─ Step N
```

普通 Step 与 Automatic Compact 使用 Loop 当前的 Active Model。Composer Selection、Session Selection 和 Registry 的普通变化不修改它。Guide/“立即”被当前 Loop 接收后，在 Model Step 边界创建并切换新的 Active Model；已经发出的请求继续使用旧 Model。

Subagent 有自己的 Model。存在显式 Selection 时创建对应模型，没有显式 Selection 时按 Execution 继承规则取得父级 Selection。Title、Memory、Repo Wiki 等独立任务也各自取得 Model，不绕过公共调用接口。

普通 Model 对象由 JavaScript GC 回收。Timer、Socket、Watcher、子进程和其他需要确定释放的资源由长期 Service owner 管理，不依赖 Model 对象何时被回收。

## Result、Event 与归因

`ModelResult` 统一非流式调用结果，`ModelEvent` 统一流式事件。Provider SDK 原始类型和原始错误封装在 Adapter 内，不直接泄漏给业务代码。

每次请求的 Usage、Trace、Model IO、cost、quota 和错误从实际 Model 取得：

```text
实际 Model
├─ providerId
├─ modelId
└─ effective options
        |
        v
Usage / Trace / Diagnostics
```

归因不读取输入框当前选择、后来变化的 Session Selection 或 Provider 响应中的可选 model 字段。Provider 返回的模型名称可以作为路由诊断信息。

## 查看与执行分离

设置页面和模型选择页面读取 Registry/Facade 投影的 ProviderConfig、ModelConfig、成员来源和状态：

```text
查看与选择
└─ Registry / Facade View
   ├─ ProviderConfig
   ├─ ModelConfig
   └─ builtin / enabled / completeness

真正执行
└─ ModelFactory(selection)
   ├─ Registry lookup / validate
   ├─ Adapter private create
   └─ Model
```

因此 Host 可以展示、分组和校验模型，而无需构造可调用 Model。disabled 与 incomplete 是创建前状态，
不进入 Model 请求契约；重复成员已经在 Inventory 阶段按“保留第一次、Built-in-wins”确定化。Model 只在
Agent Loop 或独立模型任务真正开始时创建。

## 子文档

[`contract.md`](./contract.md) 定义 ModelProperties、ModelOptionSpecs、ModelOptions、ModelRequest 检查、结果语义和 Provider reasoning 映射边界。
