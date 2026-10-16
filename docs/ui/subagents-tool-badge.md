# Subagents Tool Badge

Settings 的子智能体列表只展示工具权限摘要，不展开真实工具清单。

- `tools` 缺失、为空数组或包含 `"*"` 时，表示该子智能体继承或允许全部工具，列表 badge 显示 `All tools` / `全部工具`。
- 只有 `tools` 明确列出具体工具名且不包含 `"*"` 时，列表 badge 显示 `{count} tools` / `{count} 个工具`。

这样避免把通配符 `"*"` 误展示为 `1 个工具`。
