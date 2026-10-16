# 模型切换 Toast

## 展示契约

- 已存在的会话完成模型切换后，展示顶部居中的默认 Toast。
- 中文文案：`已从 {fromModel} 切换至 {toModel}`。
- 英文文案：`Switched from {fromModel} to {toModel}`。
- `fromModel` 与 `toModel` 沿用现有供应商/模型标签格式化规则。
- Toast 只反馈切换结果，不追加性能影响说明；草稿重选相同模型等既有抑制规则保持不变。
