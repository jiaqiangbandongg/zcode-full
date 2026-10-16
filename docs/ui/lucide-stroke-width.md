# packages/ui lucide 统一线宽

`packages/ui` 直接从 `lucide-react` 导入图标，并在应用根部用官方 `LucideProvider` 统一默认线宽。

当前默认值：

- `DEFAULT_LUCIDE_STROKE_WIDTH = 1.5`

约定：

- `packages/ui/src/Root.tsx` 负责用 `LucideProvider` 注入默认值，保持整套 UI 线条粗细一致。
- 单个图标如果有特殊视觉需求，仍然可以继续显式传 `strokeWidth` 覆盖默认值。
- 新增图标时直接从 `lucide-react` 导入，不再维护项目内图标转发封装。
- 用户定制的窗口图标位于 `components/icons/windowIcons.ts`，通过官方 `createLucideIcon` 创建，继承 `currentColor` 和全局线宽；最大化/还原图形沿用提供的 SVG 路径，不包含白色底板。
- 窗口图标使用 24×24 viewBox，图形收进 5–19 坐标范围；还原图标的前层为 `(5, 9)` 起点的 10×10 圆角矩形。按钮尺寸不随图形路径调整。
