# Error Banner Dismissal（当前事实）

Conversation error banner 的关闭状态是 pane-local UI 状态，不属于 CLI projection，也不写入 workspace Zustand bucket。

- 指纹由 session、error code、时间和 message 组合。
- 当前 pane 只保留最近约 20 个 dismissed fingerprint，防止本次视图中同一错误反复出现。
- 切换/重建 pane 后允许再次展示仍然存在的权威错误；关闭 banner 不清除 CLI error 状态。
- 新 error fingerprint 到达时正常展示。

实现入口：`packages/ui/src/v4/SessionPane.tsx`。
