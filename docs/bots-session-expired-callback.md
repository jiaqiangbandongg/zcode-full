# Bot 过期 Session 回调提示

## 背景

Bot 用户可能点击旧消息按钮，或在已失效的 active task 上继续发送消息。此时 ZCode Agent 协议层会在恢复任务时返回 `Session not found: <id>` / `Session is not active: <id>`。旧逻辑会把底层错误包装为“处理机器人回调失败”，用户无法知道下一步该怎么做。

## 方案

- provider callback 处理链路遇到 session 缺失或失活错误时，不直接把底层 session id 返回给用户。
- 用户侧提示应说明“当前任务会话已失效”，并引导发送 `/new task` 创建新任务。
- 日志仍保留原始错误，方便排查 task index、workspace identity、远程连接或 session store 不一致问题。
- 普通消息后台发送 prompt 时遇到同类错误，也使用同样的友好提示，避免错误从后台路径漏出。

## 验收

- Bot callback 中的 `Session not found: <id>` 不再作为用户可见文本出现。
- 用户可见回复包含 `/new task` 引导。
- 不改变 task/session 协议、workspace identity、remote continuous/replayable 语义。
