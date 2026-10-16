# Model Provider Context Window Badge

模型供应商设置页的模型列表会在模型 ID 输入框右侧内嵌展示上下文窗口容量。

## 展示规则

- 使用紧凑 token 容量格式：英文如 `128K`、`200K`、`1M`、`1.5M`，中文如 `12.8万`、`20万`、`100万`、`150万`。
- token 容量格式跟随 locale 本地化；英文使用 `K` / `M` / `B`，中文使用 `万` / `亿`。
- `[1m]` 后缀模型沿用运行时规则强制使用 1,000,000 上下文窗口，展示单位仍跟随 locale。
- 完整含义通过可访问标签暴露为 `上下文窗口：{value}` / `Context window: {value}`。

## 布局规则

- 容量 pill 保持在模型 ID 输入框内部，避免新增列表列宽。
- 输入框右侧预留固定空间，长模型 ID 仍由输入框自身收缩。
- 使用语义 token：`bg-surface`、`border-border`、`text-foreground-subtle`，兼容浅色和深色主题。
