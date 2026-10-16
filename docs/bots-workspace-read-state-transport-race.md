# Bot workspace 状态读取与 Agent 重启竞态

## 问题

Bot 处理 workspace 切换或读取 workspace 配置时，会通过 ZCode Protocol 的
`workspace/readState` 读取模型与模式状态。调用已经取得 workspace client 后，如果该
workspace 恰好因为配置更新、模型切换或进程生命周期变化而重启，旧 client 的 stdio
transport 会在请求发送前关闭，最终向用户返回
`ZCode agent stdio transport is closed`。

## 语义

- `workspace/readState` 是只读请求，可以在 transport 关闭竞态下重新获取当前 workspace
  client，并重试一次。
- 重试必须重新获取当前 Environment 的 client，并等待该 Environment 的 Provider Registry readiness
  后再执行 `workspace/readState`；不得从 Desktop 重推 Registry 或凭据。
- 只重试明确的 transport 已关闭错误，不扩展到创建 session、发送 prompt 等非幂等请求。
- 最多重试一次；如果 host 已整体关闭或新 Agent 仍不可用，继续抛出第二次请求的真实错误。
