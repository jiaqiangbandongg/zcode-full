# Git Commit Message 语言生成规范

更新日期：2026-07-07

## 背景

AI 生成 Git commit message 时需要遵循当前界面语言。用户选择固定语言时直接使用该语言；用户选择“系统默认”时，调用侧必须传入已经解析后的真实语言。

## 规则

- 当前只支持中文和英文两种生成语言。
- `zh-CN` 生成中文 subject / body。
- `en-US` 生成英文 subject / body。
- 无法获取当前语言，或语言不是中文时，统一 fallback 到英文。
- Conventional Commit 的 type / scope 语法保持英文，例如 `fix(git): 修复提交消息语言`。

## 数据流

- UI 通过 `useZCodeIntl()` 读取当前已解析的 `locale`。
- Git commit message 生成请求把 `locale` 传给服务层。
- 同一个请求也会携带当前会话最近文本上下文；语言规则仍以 `locale` 为准，会话上下文只用于理解修改意图。
- 如果当前会话已有文件修改 summary，UI 同时传入 `currentSessionFilePaths`；服务层只用这些文件匹配到的 staged/unstaged changes 和 diff 生成提交信息，避免其它工作区变更污染主题。
- 提交弹窗里的 staged/unstaged 文件列表也用同一份当前会话文件 summary 过滤；勾选“包含未暂存的更改”时，只 stage 并提交当前会话文件对应的未暂存改动。
- 提交弹窗底部动作区使用 Command 列表承载“提交 / 提交并推送 / 推送”；当前选中动作可通过主快捷键加 Enter 触发，macOS 使用 Command，Windows/Linux 使用 Ctrl。
- 服务层归一化语言后写入模型 prompt。
- 旧调用未传 `locale` 时，服务层尝试读取运行时 Intl locale；仍不可用则使用英文。

## 验收

- 中文界面下生成 prompt 包含 `Current language: Chinese`。
- 英文界面或未知语言下生成 prompt 包含 `Current language: English`。
- 当前会话存在文件修改 summary 时，生成 prompt 的 `Changed files` / `Diff excerpts` 只来自当前会话文件。
- 当前会话存在文件修改 summary 且勾选“包含未暂存的更改”时，提交请求的 paths 只包含当前会话文件。
- 提交弹窗中切换选中的底部动作后，主快捷键加 Enter 触发对应动作。
- 模型输出仍必须通过 Conventional Commit 第一行校验。
