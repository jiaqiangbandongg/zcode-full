# Streaming Markdown Rendering（当前事实）

V4 不再实现基于 `Intl.Segmenter` 的逐词 reveal。Assistant row 的当前完整文本直接交给 Streamdown/`MessageResponse`，Markdown 的增量可视效果来自连续 projection 更新。

- 正文事实源：`ConversationSnapshot.rows`。
- 更新入口：conversation delta。
- 渲染入口：`packages/ui/src/v4/ConversationRowView.tsx`。
- 最终一致性：terminal snapshot 文本必须等于最终渲染文本。

如将来重新引入动画，它只能是可丢弃的视觉层，不能改变 copy、搜索、恢复、虚拟滚动测高或最终 row 内容。
