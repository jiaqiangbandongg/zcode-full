# Todo 39：严格 JSON Schema 输出能力命名收口

> 状态：已由 Todo 74 覆盖（superseded）

> 状态：草案，待讨论
>
> 日期：2026-08-28
>
> 来源：Project Memory Model Selection Review

## 背景

当前 Model Properties 使用 `supportsStructuredOutput` 描述一项输出能力。这个名字容易被理解为“能够输出 JSON”、
“支持 JSON mode”或泛化的结构化文本输出，但它在现有运行链路中的实际语义更窄：模型与目标 API Schema 能够接受
调用方提供的 JSON Schema，并对响应施加严格的 Schema 约束。

该字段目前既用于 Model Config 的静态事实，也用于 Runtime 在发送 `responseJsonSchema` 前判断当前 Active Model 是否具备
对应能力。语义宽于事实的命名会让配置作者、运行时调用方和设置界面对“普通 JSON 输出”“严格 Schema 约束输出”以及
“工具调用”产生混淆，并可能造成 Built-in Model Config 的错误声明。

## 目标

- 为“严格按调用方提供的 JSON Schema 约束模型响应”建立准确、唯一的能力名称；
- 让 Config、Effective Model Config、Active Model、Runtime、Adapter、Protocol、UI 和测试使用同一语义；
- 明确区分严格 JSON Schema 输出、普通 JSON mode、提示词要求的 JSON 文本和 Tool Call；
- 确保能力判断继续来源于当前 Active Model 的冻结 Properties，不按 Model ID、Provider 或 API Type 在运行时推断；
- 使 Built-in 与 Personal Model Config 的作者能够根据明确契约准确声明该能力；
- 清除旧名称造成的歧义和兼容残留，最终只保留一个权威字段。
