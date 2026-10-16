# Web 远控快照字节预算

## 目标

手机 Web 远控打开大历史任务时，首屏不能因为单条超大 assistant 消息阻塞在完整 snapshot 传输和 JSON 解析上。当前实现只在 Web 远控场景启用快照字节预算，桌面端保持全量恢复。

## 实现

- UI 远控首屏请求携带 `messageLimit=10` 和 `byteBudget=200KB`。
- UI 远控首屏当前不再携带 `toolLimit`。工具调用保持完整条目数量，只对膨胀字段做响应态字节预算裁剪，避免破坏 assistant parts/tool 的原始顺序。
- 服务端先按消息条数裁剪尾部历史，再计算响应 JSON 体积。
- 如果体积仍超过预算，会裁剪 assistant 消息的 `content` / `thought`、工具调用的 `input` / `output` / `raw`，以及 `fileChanges` 里的 `beforeContent` / `afterContent`。
- `bodyRefs` 包含字段名、完整正文 hash、完整字节数、预览字节数和可补拉的 `refId`。
- 工具调用裁剪后会在工具对象上返回 `snapshotRefs`；文件变更裁剪后会在文件快照上返回 `contentRefs`。
- `toolSlice` / `getTaskSnapshotToolCallsSlice()` 保留为服务能力，但当前手机远控首屏不主动按工具条数切片。
- `raw` 裁剪时会保留 `toolCallId`、`kind`、`title`、`status`、`_meta.claudeCode.toolName`、`_meta.claudeCode.parentToolUseId`、小型 `backgroundAgent` 等关联元数据，避免破坏历史工具块的 ID 和父子关系。
- 手机端看到 `bodyRefs` 时显示“当前只显示预览”，并提供“查看完整消息”按钮。
- 点击后调用 `getTaskSnapshotBody({ refId })` 补拉完整正文，hash 校验通过后替换本地 store 中的预览内容。

## 当前阈值

- 整份远控首屏 snapshot 目标预算：`200KB`。这是响应态软预算，服务端会先裁剪最容易膨胀的字段；如果剩余结构元数据本身超过预算，不会继续删除结构字段来硬压到预算以下。
- assistant `content` / `thought`：预览上限为 `min(32KB, max(2KB, floor(byteBudget / 3)))`。
- tool `input`：超过 `1KB` 后裁剪为 `256B` 预览。
- tool `output`：超过 `4KB` 后裁剪为 `512B` 预览。
- tool `raw`：超过 `2KB` 后裁剪为 `256B` 序列化预览，同时保留必要关联元数据。
- fileChanges `beforeContent` / `afterContent`：超过 `8KB` 后裁剪为 `4KB` 预览。

## 数据完整性

- 裁剪只发生在响应态 snapshot，不写回本地 session JSON。
- `refId` 使用持久化消息原始下标，而不是裁剪后数组下标，避免 `messageLimit` 下补拉错消息。
- 如果 hash 不匹配或正文不存在，UI 保留预览态并允许重试。
- 运行中尚未持久化的临时 assistant 消息不会生成 `bodyRefs`，避免产生无法补拉的引用。
- `getTaskSnapshotRef({ refId })` 会重新读取本地 task JSON，并用 hash 校验后返回工具字段或文件内容完整值，保证裁剪不会改变持久化数据完整性。
- 如果未来重新启用工具条数切片，`getTaskSnapshotToolCallsSlice({ taskId, messageIndex, startToolIndex, limit })` 会按原始工具下标范围返回切片；当前主路径依赖字段级裁剪，不依赖工具分页补齐。

## 交互约束

- 预览态下复制按钮会提示“加载完整消息后复制”，避免把预览文本误当成完整正文复制。
- 旧历史“加载更早消息”和单条大消息“查看完整消息”是两条独立链路：前者补消息条数，后者补单条正文。工具调用数量当前不在首屏被裁掉，因此没有独立的“查看更多工具调用”主路径。
