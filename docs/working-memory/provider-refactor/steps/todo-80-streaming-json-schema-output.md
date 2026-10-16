# Todo 80：流式 JSON Schema 输出支持

> 状态：草案，待讨论
>
> 日期：2026-09-04

## 问题

当前 `responseJsonSchema` 只在非流式 `generateText` 路径生效：

```text
generateText -> 传递并编码 JSON Schema
streamText   -> 当前不传递 JSON Schema
```

这与“支持 JSON Schema 时，请求应按同一契约处理”的目标不一致，但目前生产调用方主要使用非流式路径，因此暂未确认这是需要立即扩大的产品能力，还是明确保留的边界。

## 初步想法

- 单独研究流式 JSON Schema 是否需要支持，以及需要返回“最终对象”还是“对象增量”。
- 优先考虑不新增 `ModelStreamEvent`：如果产品只需要最终结果，可以在流结束时取得完整对象，再沿用现有结果契约。
- 如果确实需要对象增量，再单独设计流式事件和 Core/UI 消费链路，不在本 Todo 中提前假设。
- 先以 Anthropic Messages 为研究对象，不扩展其他 API Schema。

## 本 Todo 暂不处理

- 不修改当前生产代码；
- 不改变非流式 JSON Schema 行为；
- 不设计完整的流式事件协议；
- 不处理 PDF、工具调用或 Provider Config 分层。
