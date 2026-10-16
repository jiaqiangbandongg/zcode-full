# Goal Query Readonly

## 背景

`/goal` 和 `/target` 在聊天区虽然以用户 query 的形态展示，但它们不是普通 prompt：

- 发送入口会把它们路由到 session goal 控制命令。
- set / replace 会写入当前 session target，并可能触发 goal continuation。
- pause / resume / clear / show 是 goal 状态控制，不应被当作可重试的自然语言 query。

## 交互约束

聊天区中由纯文本 `/goal ...` 或 `/target ...` 产生的用户消息保持只读：

- 不展示用户消息的编辑 / retry action。
- 复制、时间展示、展开长文本等只读操作保持可用。
- query 正文开头的 `/goal` / `/target` 是提交控制语法；只读用户气泡继续用 Goal
  图标和 command 语义色展示 `goal` / `target` 标签，但不渲染开头的 `/`，后续目标
  正文保持普通用户文本样式。
- 复制、行内编辑和 command intent 仍使用原始 `UserInputRow.text`，不能因为展示层
  省略 `/` 而丢失原始 `/goal` / `/target`。
- 普通正文中提到 `/goal` 不受影响。
- 带附件的 `/goal ...` 不按 goal slash command 处理，仍沿用普通消息行为。
- 带网页元素、会话选区等上下文附件的 `/goal ...` 同样按普通消息展示，不能只因
  上下文块从可见正文中被剥离就误渲染为 goal query。

命令 token 省略 `/` 只改变 renderer 的只读正文，不改变消息文本、复制内容、编辑目标或
desktop continuous / web remote replayable 的投影语义；桌面端和手机 Web 端共用同一
行渲染组件，并使用已有语义色以兼容亮色、暗色主题。

## 实现约束

UI 判断必须复用和发送入口一致的 visible slash command 语义，不能只通过字符串包含
`/goal` 判断。这样可以避免普通讨论文本、国际化文案、带文件或上下文附件的消息被
误判为 goal query。展示解析只用来识别已确认 goal query，并在 command 标签中省略
开头的 `/`；权威原文仍使用 `UserInputRow.text`，不能从渲染结果反推或重写 command
intent。
