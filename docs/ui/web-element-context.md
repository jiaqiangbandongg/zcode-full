# Web Element Context

ZCode 的内置浏览器支持在桌面端把网页元素加入聊天上下文。

## Flow

1. Browser toolbar 中的元素选择按钮进入 picking mode。
2. `EmbeddedBrowserPane` 通过 Electron `webview.executeJavaScript` 临时注入 picker。
3. 用户 hover 时页面内部显示高亮和基础信息浮窗，click 后采集当前元素并退出；Esc 会取消选择态。
4. Renderer 派发 `zcode:web-element-context-add-to-chat` 事件。
5. Chat composer 显示网页元素 chip，发送时把上下文拼成 Markdown text block。

## V4 Composer Wiring

V4 不新增协议字段，web element context 仍然是 prompt 文本上下文；chip 只是 composer
与 transcript 的可视化外壳。

```
EmbeddedBrowserPane
  -> zcode:web-element-context-add-to-chat
  -> ConversationComposer/useWebElementContexts
       workspaceKey = workspaceIdentity?.trim() || workspacePath
       transient in-memory contexts[]
  -> WebElementContextAttachmentChip
  -> submit:
       visible text + buildPromptWithWebElementContexts(...)
       contextAttachmentCount > 0
  -> SessionPane:
       parseV4VisibleSlashCommand(..., { contextAttachmentCount })
       contextAttachmentCount > 0 => do not consume /goal or /compact locally
  -> createSession/sendText
  -> ConversationRowView:
       parsePromptWebElementContexts(row.text)
       visible content + read-only WebElementContextAttachmentChip
```

## V4 State Boundaries

- Composer chip 只保存在当前 React composer 内存中；切 session、切 workspace、刷新页面都会清空。
- 草稿持久化只保存文字/editorState，不保存 web element context。
- 发送成功后清空 context；发送失败保留 chip 和输入，便于重试。
- `contextAttachmentCount` 只用于 app 侧 slash-command 保护，不进入 v4 protocol payload。
- Transcript copy/edit/retry 使用原始 `row.text`，因此 Markdown context block 不会丢失。

## Boundaries

- 采集逻辑只运行在桌面端 `webview` 内，不经过 host process 或 service。
- Web / 手机端不直接读取跨站 DOM，第一版不支持该能力。
- 上下文按 `workspaceIdentity?.trim() || workspacePath` 归属当前 workspace。
- V4 远程 workspace 必须继续传 `workspaceIdentity`；禁止只按 `workspacePath` 过滤 context。
- 不读取 cookie、localStorage、sessionStorage，也不采集 input 当前 value；password input 会被 mask。
- 发送给 ZCode Agent 的内容是纯文本 Markdown，兼容当前 provider。

## Captured Fields

- page URL and title
- tag name, role, accessible name
- selector and XPath
- visible text and nearby text
- safe attribute whitelist
- visible bounding rect
- computed style summary: color, background color, font family, font size, font weight, display
- sanitized HTML excerpt

All large text fields are truncated before entering the prompt.
