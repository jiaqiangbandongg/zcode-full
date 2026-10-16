# Chat Scroll Events（当前事实）

旧“移除 onScroll/ResizeObserver”的方案已被 V4 虚拟时间线取代。当前 `ConversationTimeline` 使用：

- `onScroll` 判断用户位置和 follow-bottom；
- `ResizeObserver`/动态测高维护流式 row 高度；
- virtualizer 控制可见 turn 渲染；
- 滚底按钮帮助用户恢复自动跟随。

这些事件只维护 UI 视图状态，不能影响 conversation seq/projection。
