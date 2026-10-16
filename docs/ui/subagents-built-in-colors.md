# Built-In Subagent Colors

内置子智能体必须在 profile 数据上提供显式颜色，不依赖 UI 按名称 hash 的 fallback。

- `general-purpose` 使用 `blue`。
- `Explore` 使用 `cyan`。
- UI 仍保留按名称 hash 的 fallback，只用于旧事件、外部 agent 或没有配置颜色的自定义 subagent。
- 内置颜色只是身份标识，不表达成功、失败、危险等状态语义。

这样可以避免内置 `general-purpose` 因名称 hash 结果显示为 `red`，让用户误以为它是错误或危险状态。
