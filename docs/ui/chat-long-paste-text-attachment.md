# Chat Long Paste Text Attachment

## 背景

聊天输入框使用 Lexical 承载正文。用户把超长文本直接粘进输入框时，会让编辑器序列化、草稿同步和移动端输入体验都变重。现有附件链路已经能发送 `text/plain` 文件附件，因此长文本粘贴应进入附件语义，而不是继续扩张正文。

## 产品规则

- 仅处理剪贴板里的纯文本内容。
- 当纯文本大于等于 5120 个 UTF-16 code units 时，粘贴操作不再把内容插入输入框正文，而是写入宿主临时目录并创建一个本地文件附件。
- 触发判断不依赖行数：单行超长 JSON、日志或 base64 同样会转成附件；小段多行文本只要低于阈值，仍保持浏览器和 Lexical 默认粘贴行为。
- 行数仍按 `\n` / `\r\n` / `\r` 兼容计算，但只作为附件 chip 的展示元信息，不参与是否转附件的判断。
- 如果同一次粘贴包含文件，文件附件逻辑优先，避免把截图、拖出的文本文件或其他附件形态误判为正文粘贴。
- 如果宿主临时文件创建失败，粘贴操作保持被拦截并展示附件错误，不回退把长文本塞入正文。
- 转附件不自动改写输入框已有正文；空正文也允许只带附件提交。
- 附件数量继续复用聊天附件上限：最多 8 个。

## 附件数据

长文本粘贴附件在 UI 侧记录为 `sourceKind: "clipboard-text"`，并保留：

- `lineCount`：原始剪贴板文本行数。
- `charCount`：原始剪贴板文本字符数。
- `sizeBytes`：宿主写入临时文件后的 UTF-8 字节数。
- `filename`：机器可追踪的 `.txt` 文件名，例如 `pasted-text-20260627-153012.txt`。
- `localPath`：宿主临时文件路径。

长文本内容落盘到 `{ZCODE_DATA_BASE_DIR || HOME}/.zcode/tmp/paste-attachments/YYYY-MM-DD/`。文件名使用时间戳文件名加随机后缀，避免暴露正文内容或发生冲突。发送协议复用现有 `kind: "file"`、`mimeType: "text/plain"`、`localPath` 路径，并携带 `sourceKind: "clipboard-text"` 标记，不再携带 `textContent`，避免长文本直接进入 prompt payload 或模型上下文。

Agent 接收该标记后必须把它当作用户上传的临时本地文件附件处理：模型请求里只出现文件路径附件引用，不自动读取文件正文，也不生成 `prompt_attachment` system reminder。只有模型后续显式调用文件读取工具时，临时文件内容才进入上下文。普通用户上传的小型文本文件保持既有行为，可以继续被投影为 Read-like 附件上下文。

普通 Web 没有宿主文件系统时不支持该能力；手机 Web 远控必须通过 shared-host/platform proxy 写到已连接的桌面宿主临时目录，不在手机浏览器本地伪造路径。

## UI 展示

Composer 附件区保持一行 chip：

```text
[clipboard-pen-line] 粘贴文本 · 128 行 [x]
```

- 图标使用 lucide `ClipboardPenLine`。
- 标题使用国际化文案，不直接展示机器文件名。
- 行数作为同一行元信息展示；空间不足时标题/元信息整体截断，删除按钮固定在右侧。
- chip 主体和删除按钮浮层都使用 `background` 作为底色，避免右侧遮罩和附件主体出现不同 surface 层级。
- 删除按钮参考 side pane tab：在 chip 右侧使用 hover/focus 显示的浮层关闭区，并用渐变遮罩覆盖文本末尾，避免行数文本和按钮互相挤压。
- 视觉风格复用现有 inline attachment chip，不新增卡片式容器。

## 多端边界

- 桌面端、Web 端、手机远控都走同一 UI paste 逻辑和同一 prompt attachment 协议，不新增 runtime、不改变 shared-host attachment 架构。
- 该功能只影响提交前的 composer 输入组织，不改变 desktop continuous 与 web remote replayable 的 task stream 语义。
