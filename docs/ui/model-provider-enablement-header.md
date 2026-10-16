# Model Provider Enablement Header

模型供应商详情页的启用状态与启停动作在同一标题行展示。

- 状态标识显示在 provider 名称后面。
- “启用 / 禁用”按钮紧跟状态标识，避免和右侧次级动作混在一起。
- 右侧动作区仅保留查看用量、删除等非启停操作。

相关实现：

- `packages/ui/src/settings/model-provider-section/ProviderCardSections.tsx`
- `packages/ui/test/modelProviderEnablementHeader.test.ts`
