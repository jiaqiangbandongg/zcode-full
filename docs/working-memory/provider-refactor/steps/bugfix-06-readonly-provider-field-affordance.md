# Bugfix 06：Provider 只读字段锁定提示

> 状态：已完成

## 问题

Built-in Provider 的 Base URL 与 API 格式会按 Official Config 展示，但设置页使用了和普通输入框
几乎相同的视觉结构。字段虽然不能聚焦或编辑，用户仍无法在浏览时直接判断它是只读事实，容易把
“无法点击”理解成控件失效。

## 目标行为

- Base URL 与 API 格式继续展示真实 Effective Provider Config；
- 只读字段保持普通输入框的背景、边框、字号和高度，不增加禁用透明度或额外卡片；
- 每个只读字段在右侧固定展示锁图标，明确表达当前字段不可编辑；
- 锁图标提供本地化的无障碍名称，不能只依赖视觉图形传达状态；
- 长 Base URL 可以继续换行，文本占据剩余空间，锁图标不被挤压；
- 可编辑 Provider、API Key、模型配置、保存和 Overlay 语义完全不变。

## 根因与修复边界

根因是 `ProviderConnectionSection` 的只读分支只复刻了输入框表面，没有提供只读状态的视觉提示。
修复只在该展示分支增加统一的只读字段组件和锁图标，不修改 Provider Config、Registry 或权限判断。

## 验收

- 普通 Built-in Provider 的 Base URL 和 API 格式各展示一个锁图标；
- 锁图标在中英文环境均有可访问名称；
- 可编辑 Provider 仍使用原有 Input/Select，不出现锁图标；
- Desktop、Web、窄宽布局和所有主题保持可用；
- UI 定向测试、typecheck、lint、格式检查与 `git diff --check` 通过。

## 实施结果

- `ProviderConnectionSection` 的只读分支统一使用单层只读字段外观，Base URL 与可见的 API 格式
  右侧固定展示 `LockKeyholeIcon`；
- 文本使用 `min-w-0 + flex-1 + break-all` 占据剩余宽度，锁图标保持 `shrink-0`，长 URL
  不会覆盖或挤掉状态提示；
- 中英文分别提供“{field}（只读）”和“{field} (read only)”无障碍名称；
- 可编辑分支仍使用原有 `Input` 与 `ProviderApiFormatSelect`，没有改变保存、Overlay 或 Registry；
- Provider/Model UI 定向测试 36 个通过，根 `pnpm typecheck` 通过，根 `pnpm lint` 通过
  （0 error，34 个既有 warning），修改文件格式检查和 `git diff --check` 通过。
