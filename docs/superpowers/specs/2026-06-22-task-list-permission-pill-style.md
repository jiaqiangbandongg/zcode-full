# Task List Permission Pill Style

## 背景

普通 TaskList 的“等待确认”状态使用 `Badge` 组件渲染，默认是 `rounded-full` pill。Grouped task row 里同一状态使用手写 `span rounded-sm`，导致同一个任务状态在不同列表视图里视觉不一致。

## 目标

- Grouped task row 的“等待确认”复用 `Badge` 组件。
- 保持成功色语义和 hover 隐藏行为不变。
- 不修改 task 选择、拖拽、归档、permission 状态判断逻辑。

## 兼容约束

- 桌面侧栏、全局 grouped task 视图、浅色/深色主题使用一致 pill 样式。
- 只调整 UI 标签外观，不改变 ZCode session / task realtime 消息流。
