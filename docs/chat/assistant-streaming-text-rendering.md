# Assistant Streaming Text Rendering（当前事实）

Assistant 正文来自 V4 `assistantText` row。CLI reducer 产生 row delta，`ConversationProjectionStore` 应用后，`ConversationRowView` 把当前完整 `row.text` 交给 `MessageResponse`/Streamdown 渲染。

当前没有旧 `useTaskStreamEvents` 50ms batch，也没有 UI 自行维护的逐词 reveal 队列。节奏由权威 delta 到达和 React 渲染决定；结束态必须与 snapshot 中的 row 文本逐字一致。

```text
CLI text event -> ProductProjection row delta -> SessionDataLayer
  -> ConversationProjectionStore -> ConversationRowView -> MessageResponse
```

优化流式体验时不能在 UI 生成第二份正文或用 timer 改写最终文本；合批必须保持 seq、rowId 和 snapshot/delta 收敛语义。
