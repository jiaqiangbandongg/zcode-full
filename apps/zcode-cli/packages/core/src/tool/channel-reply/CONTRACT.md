# 渠道回复工具入口

登记既有 `ReplyToChannel` 工具入口，保留公开导入路径。调用继续通过公共工具链进入同一个 handler；契约只引用原 ToolEntry 与共享输入、结果 schema。

- 以实际工具调用所属 assistant 的 parentID 绑定用户输入，不取后续排队消息的授权。
- 发送由现有 Host 端口执行；工具不新建渠道连接，不复制任务绑定。
- 继续保留 deferred 分类、非只读与非并发安全属性；取消、参数校验和权限语义不变。
- 澄清结果不表示已发送；恢复或重试不合成用户授权。

运行时回归位于 `tests/reply-to-channel.test.ts`。
