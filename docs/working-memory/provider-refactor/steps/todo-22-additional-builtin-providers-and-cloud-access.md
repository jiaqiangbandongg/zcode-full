# 22 新增 Built-in Provider 与云平台 Access

> 状态：草案
>
> 日期：2026-08-26
>
> 来源：ZCode Built-in Config 内容整理中已经确认的新增 Provider 范围；从 Todo 21 拆出，避免配置职责重构与新
> Provider/Access 接入互相阻塞
>
> 相关任务：[`21`](./todo-21-zcode-builtin-config-ownership-and-model-activation-order.md)
>
> 相关设计：[`Provider 与 Model 配置体系综述`](../design/registry/provider-and-model-configuration-overview.md)、
> [`configuration.md`](../design/registry/configuration.md)

## 0. 任务定位

本 Todo 独立承接尚未进入当前 `config/provider/zcode-builtin.json` 的普通聚合网关和云平台 Provider。Todo 21 继续
收口 Provider/Model 配置职责、启用、排序、Settings 和 Access 归属；不因等待新的 Provider Adapter 或 Access Type
而扩大实施关键路径。

Built-in 只表示模板由 ZCode 内置维护，不表示使用 ZCode 账号。新增普通 Provider 由 Template Model 的 `enabled` 决定默认是否进入可选模型集合；不再使用 Provider 顶层 `enabled` 表达加入配置或执行资格：

```text
Template Model Rule
└─ enabled = false（默认）
```

用户从“添加供应商”选择后创建 Personal Provider Instance，再由对应的 Personal Model Rule 保存模型启停和访问材料；配置完整后才进入 Registry。

## 1. 当前候选范围

### 1.1 优先验证现有 API Access 能否完整表达

- OpenRouter；
- OpenCode Zen；
- Microsoft Azure AI Foundry / Azure OpenAI；
- Volcano Engine Ark。

这些 Provider 只有在现有 `api.type + api.baseURL + access.type="api"` 能准确表达真实 Endpoint、Header、请求参数和
模型 ID 语义时，才作为普通 Built-in Provider 模板加入。不能因为服务声称 OpenAI-compatible 就跳过最终请求体和
响应流验证。

### 1.2 明确需要新 Access 设计

- AWS Bedrock。

Bedrock 的 Region、凭据来源、请求签名、Endpoint 生成和模型身份不能伪装成普通 API Key + 手写 URL。正式实现前必须
先设计 Bedrock Access、Adapter 装配、Settings 表单、凭据生命周期和 Local/Remote Environment 边界。

### 1.3 当前排除

- Google Gemini 原生 Provider；
- Google Vertex AI。

Google 相关接入当前不支持，不在本 Todo 内顺手建立 Adapter 或 Access Type。未来重新立项时再基于当时官方接口设计。

## 2. 共同原则

1. Provider 模板进入同一 ZCode Built-in Release，不恢复 Catalog、Preset 或远端第二事实源；
2. Provider 身份、API、Endpoint 模板和 Access 属于 Built-in Provider Config；
3. 模型 Properties、Option Specs、Reasoning Mapping 和必要请求编码事实属于 Built-in Model Config Rules；
4. 普通 Provider 不按 Provider ID 或 Model ID 在 Adapter/Runtime 写 hardcode；
5. 每个新增 Provider 必须有最终 HTTP 请求/响应契约证据，不能只证明 SDK factory 能创建；
6. Settings 使用 Todo 21 的“添加供应商”入口、显式 `builtin`、启用和排序契约；
7. Local workspace 使用 Local Host 配置，remote workspace 使用 Remote Host 配置和凭据，不从 Renderer 投影本地事实；
8. 不为暂未实现的 Access/Adapter 发布看似可配置、实际不可执行的 Built-in 模板。

## 3. 实施前待设计

### 3.1 OpenRouter 与 OpenCode Zen（已迁移）

> 本章节已迁移到 [Todo 79：OpenRouter / OpenCode Provider 接入边界与现有基础](./todo-79-openrouter-opencode-provider-integration-boundary.md)。Todo 22 仍保留 Azure、Volcano Ark 和 AWS Bedrock 的规划，不应整体标记为完成。

- 确认使用的公开 API Schema；
- 确认模型 ID 是否包含 `/` 及其在结构化 `ModelSelection` 中的处理；
- 确认 reasoning、tool call、structured output、web search 与 usage 的实际请求/响应；
- 确认 Endpoint、API Key 管理地址和推荐模型成员；
- 确认当前 Adapter 是否需要任何有证据的窄兼容事实。

详见 Todo 79。原有 OpenRouter/OpenCode 讨论保留为迁移索引，不在此重复维护。

### 3.2 Azure

- 确认资源 Endpoint、Deployment 与 Model ID 的关系；
- 确认 API version 应属于静态 API 配置、Endpoint query，还是 Adapter 选项；
- 确认 API Key Header 与响应协议；
- 若现有 API Access 无法完整表达，先升级 Access/API 设计，不在 Built-in JSON 中写半成品。

### 3.3 Volcano Ark

- 确认 Endpoint/Deployment ID、API Key 和模型身份；
- 确认当前 OpenAI-compatible Adapter 的请求与流式响应兼容性；
- 确认推荐模型及其完整 Model Config Facts。

### 3.4 AWS Bedrock

- 新 Access Type 的领域结构；
- Region、静态凭据、凭据引用与请求期刷新边界；
- SigV4 或当前正式签名协议的 Transport 位置；
- Endpoint 自动生成与自定义 Endpoint 的安全边界；
- Bedrock Model ID 与 Provider 原始 Model ID 的映射；
- Desktop、CLI、Web/Remote Host 的凭据录入与执行归属；
- Connectivity、错误归一化和日志脱敏。

## 4. 验收原则

每个 Provider 至少证明：

```text
Built-in Provider Template
        +
Personal Access/Endpoint Overlay
        +
Built-in Model Config Rules
        |
        v
完整 Registry Provider/Model
        |
        v
真实 generate + stream 请求
```

并覆盖：

- Template Model 默认 `enabled=false`，创建 Personal Provider Instance 后由对应 Personal Model Rule 保存模型启停；
- 缺少访问材料时保留 Settings 可编辑状态但不进入 Registry；
- Model Rules 能解析完整 Properties、Options 与 Reasoning Mapping；
- Tool Call、Structured Output、Reasoning 与 Usage 至少有代表性真实请求证据；
- 删除供应商只删除 Personal 配置，Built-in 模板回落；
- Provider/Model 顺序遵守 Todo 21；
- Local/Remote Environment 不混用配置或凭据；
- 类型检查、Lint、Config integrity 和相关 Adapter 测试通过。

## 5. 非目标

- 不在 Todo 21 中提前发布上述半成品 Provider；
- 不支持 Google Gemini 或 Vertex AI；
- 不把 Bedrock 强行建模为普通 API Key Provider；
- 不承诺所有聚合网关背后的任意模型都具有相同能力；
- 不恢复 models.dev、Catalog、按模型名 Runtime 推断或 Provider family hardcode；
- 不统一重构全部 `/client/configs` 消费者。

## 6. 草案状态退出条件

本 Todo 在以下事项完成后才可改为“待执行”：

1. 分别确认 OpenRouter、OpenCode Zen、Azure、Volcano Ark 的现有 Adapter/Access 可表达性；
2. 完成 AWS Bedrock Access 专题设计；
3. 为每个 Provider 确认首批 Built-in 模型与权威事实来源；
4. 确认实现切片和真实请求验证条件；
5. 将最终 Provider/Access 契约写入 Design Tree。
