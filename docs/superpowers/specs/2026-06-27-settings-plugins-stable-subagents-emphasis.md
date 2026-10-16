# Settings Plugins Stable Status and Subagents Scope Emphasis

## Goal

Plugins 管理能力已结束 beta 阶段，设置页不再展示 beta 徽标；同时继续突出 Subagents 面板当前不支持工作区级创建或编辑的范围限制。

## Scope

- Plugins 设置页主标题仅展示标题，不再展示 `Beta` / `测试` 徽标。
- Subagents 设置页说明文案保留基础说明；范围限制提示移动到新增 subagent 表单的保存按钮左侧。
- 范围限制提示前置 info 图标，并使用 `text-foreground`，保持中英文 i18n。

## UI Requirements

- Plugins 设置内容区标题与左侧设置导航条均不展示 beta 状态。
- Subagents 范围限制文案展示在新增 subagent 表单 footer 的保存按钮左侧，前面展示 info 图标，并使用 `text-foreground`，不能硬编码中文字符串。
- 移动端和窄布局下标题保持正常布局，不保留徽标占位。

## Non-goals

- 不改插件协议、安装逻辑或 marketplace 数据。
- 不新增 Subagents 工作区级创建或编辑能力。
