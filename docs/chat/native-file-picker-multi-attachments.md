# Native file picker multi-attachment spec

## 背景

聊天输入框附件模型已经支持多个附件，Web 文件输入和拖拽入口也能一次添加多个文件；但桌面端原生文件选择器只通过 `selectFile()` 返回单个本地路径，导致点击附件按钮时每次只能添加一个文件。

## 目标

- 桌面端聊天输入框的原生文件选择器支持一次选择多个文件。
- 继续沿用现有附件上限 `MAX_CHAT_ATTACHMENTS = 8`，超过剩余槽位时保留现有截断和提示行为。
- 保留 `selectFile()` 的单文件语义，供 SSH 私钥等单文件选择场景继续使用。
- Web、手机远控和拖拽附件入口行为不变。

## 方案

- 平台层新增 `selectFiles(): Promise<string[]>`，只表达“选择多个可被 agent 访问的本地绝对路径”。
- Desktop main 进程新增对应 IPC handler，Electron `showOpenDialog` 使用 `["openFile", "multiSelections"]`，取消时返回空数组。
- Desktop preload / renderer platform 暴露 `selectFiles()`。
- 聊天输入框在 `canSelectFilePath` 为 true 时优先调用 `selectFiles()`；若旧宿主没有该方法，则 fallback 到 `selectFile()`。
- 每个返回路径复用现有 `createChatComposerPathAttachment` 和 `addPreparedAttachments`，避免新增附件模型。

## 非目标

- 不改变远程连接表单、私钥选择、目录选择等单文件/单目录 picker。
- 不改变 Web 端 `<input type="file" multiple>` 或拖拽附件解析逻辑。
- 不提高附件数量上限。
