# Chat error detail telemetry

Todo103 G13-C；来源 `e690365f2e`、`a5f4687368`。保留错误摘要、展示用 detail、错误分类和重试行为，仅补底层错误诊断。

```text
Core 有界错误链投影
   -> TurnErrorPayload
   -> ProductProjection / V4 lastError schema
   -> SessionPane / UI error normalization
   -> chat_error_banner
```

- `underlyingErrorMessage`：最深的非 wrapper frame 的 message。
- `underlyingErrorDetail`：同一 frame 的 detail / errorDetails / details。
- 没有非 wrapper frame 时使用最后一个 frame；没有对应内容则字段缺省。沿用原错误链的循环防护、长度上限，不遍历任意 context / headers / responseBody。
- UI 只传递结构化字段，不重新推断底层原因。底层 message 可经检查后上报为 `error_detail_message`；保留现有事件名、去重和分类维度。
- 与上游的明确差异：`docs/monitoring/conversation-telemetry-v4.md` 禁止上传完整 detail、URL、认证头、原始响应。因而不恢复上游 `error_detail_text` 的直接上报，截断 500 字符不等于脱敏。`underlyingErrorDetail` 只在内部协议 / UI 保留，不能直接进入遥测。
- 新增 message 上报遵守长度限制，识别到凭据 / 认证头、URL 或 HTML 原始响应时使用固定脱敏提示；不影响本地展示用 detail。此文本检查不是任意敏感内容的完整识别器，错误生产者仍不得把完整 prompt/tool 内容塞进 message。
- Live 与 snapshot schema 均保留字段；不能只扩类型却被中间转换丢掉，也不改变 desktop continuous / web replayable 路由。

验收：Core 多层 cause 和同一底层 frame；缺省 / wrapper / 环路；投影与运行时 schema 往返；UI normalization 包装路径；Banner 转换与最终 payload；已识别敏感文本及超长底层消息受限，底层 detail 一律不上报。
