# Slash Command Leading Dunhao Alias

## 背景

中文输入法下，用户想在聊天输入框第一位输入 `/` 唤起 slash command 时，可能会打出中文顿号 `、`。如果直接把 `、` 纳入 slash command 匹配，会扩大命令解析边界，也容易影响正常中文标点输入。

## 目标

- 仅在聊天输入框中处理用户手输的首字符 `、`。
- 当 `、` 会成为输入框全文第一个字符时，立即替换成 ASCII `/`。
- 替换后继续复用现有 `/` slash command 面板、过滤、mention 插入和发送解析逻辑。
- 不全局替换正文里的顿号，不处理粘贴或程序预填内容。

## 边界

- 只处理浏览器 `beforeinput` 里的 `inputType === "insertText"` 且 `data === "、"` 的真实输入。
- 光标不在编辑器全文开头时不替换，例如 `你好、` 保持原样。
- 粘贴 `、goal`、历史草稿恢复、外部预填等程序化内容不替换。
- slash command 的匹配和执行仍只识别标准 `/`，本功能只在输入进入编辑器前做一次纠正。

## 兼容性

- 逻辑位于 `packages/ui` 的 Lexical 输入层，桌面端、本地 Web 和手机远控复用同一输入组件。
- 不修改 `@zcode/protocol`，不影响 agent、session、continuous/replayable 消息流或远控 task command queue。

## 验收

- 空输入框手输 `、` 后，输入内容变成 `/` 并自然唤起 slash command 面板。
- 光标在已有内容开头手输 `、` 时，首字符被纠正成 `/`。
- 光标不在全文开头时手输 `、` 不会被替换。
- 粘贴或程序写入 `、goal` 不会被替换。
- 原有 `/` slash command 行为保持不变。
