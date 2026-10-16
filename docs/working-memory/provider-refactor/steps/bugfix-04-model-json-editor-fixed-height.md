# Bugfix 04：Model JSON 编辑器固定高度

> 状态：已完成

## 问题

Model 配置弹窗中的推理档位 Option Spec 与 Reasoning Mapping 使用多行 JSON 文本。
共享 `Textarea` 默认采用 `field-sizing-content`，因此 Personal 值为空、Effective JSON 作为
placeholder 展示时，输入框会随多行 placeholder 自动增高。较长 Mapping 会把弹窗内容整体撑长，
也让 JSON 看起来像散落在页面上的普通文本。

## 目标行为

- 三个 JSON 配置项继续使用原生可编辑 `Textarea`，不引入第二套 JSON 状态或编辑器依赖；
- JSON 文本框使用统一固定高度，不随 value 或 placeholder 的行数变化；
- 超出高度的 JSON 在文本框内部纵向滚动，弹窗本身只负责字段之间的滚动；
- Personal 值为空时，Effective JSON 仍只作为 placeholder 展示，不写入 Personal Overlay；
- 保持等宽字体、JSON 标记、键盘编辑、主题和桌面/Web 共用行为。

## 根因与修复

根因不是 Config 或 Overlay，而是 `JsonSlotEditor` 只设置了最小高度和可拖动 resize，未覆盖共享
`Textarea` 的内容自适应尺寸。

修复在 `JsonSlotEditor` 的视觉边界内完成：覆盖为 `field-sizing-fixed`，使用固定高度，关闭手动
resize，并启用内部滚动。不得修改 JSON 解析、Draft、Effective Preview 或保存语义。

## 验收

- 长 JSON value 和长 Effective placeholder 均不会改变文本框高度；
- 三个 JSON 文本框高度一致；
- 文本框具有清晰的输入边界，内容溢出时可内部滚动；
- 保存与恢复默认行为不变；
- UI 单测、typecheck 和 lint 通过。

## 实施结果

- `JsonSlotEditor` 已统一使用固定高度和内部纵向滚动，长 value/placeholder 不再撑高弹窗；
- 三个 JSON 字段继续复用同一编辑器，不改变稀疏 Personal Overlay、Effective placeholder 或恢复默认语义；
- 定向测试明确断言 `field-sizing-fixed`、固定高度和 `resize-none`；对应实现提交为 `39cb217ca3`。
