# Task-scoped composer drafts

## 背景

聊天输入框的未发送状态必须跟随 task 隔离，而不是跟随当前组件实例。用户在 A task 输入文本、添加附件或上下文 chip 后切到 B task，再切回 A task，应看到 A 自己的草稿；B task 也同理。

## 缓存边界

- workspace 隔离使用 `workspaceKey = workspaceIdentity?.trim() || workspacePath`。
- 草稿作用域使用 `taskId`；新建任务态使用 `null`，在 store 中映射为 `__draft__`。
- 每个作用域缓存完整 composer draft：文本、普通附件、code comment、web element context 和本地 revision。
- 桌面端恢复时优先重放 Lexical editor JSON 快照，保留 mention / token 节点；旧草稿或快照缺失时回退到纯文本恢复。
- focus、拖拽高亮、提示词增强 loading 等瞬时 UI 状态不进入草稿缓存。

## 持久化规则

- 当前 renderer 内存里按 workspace/task 独立保存，切换 task、卸载、页面隐藏、queued prompt edit、首发 task promotion 都要保存/恢复。
- 输入热路径只更新本地 composer state 和 revision，不按每个字符写全局 store/localStorage；完整草稿只在切换 task、卸载/隐藏、prefill/queued edit、首发 promotion、发送失败/成功边界保存或清理，避免大附件和长文本造成高频重渲染或持久化写入。
- 桌面端重启恢复使用 localStorage 的小型 JSON 缓存；key 中必须包含 workspace key，避免远程 workspace 同路径串线。
- 普通附件只持久化可恢复引用：带 `localPath` 的文件附件可以恢复；没有可恢复路径的浏览器 `File` 不复制到应用存储，重启后丢弃并提示用户重新添加。
- task 删除或发送成功后清理对应草稿，避免旧附件引用继续出现在后续会话。
