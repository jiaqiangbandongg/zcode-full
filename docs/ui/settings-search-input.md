# Settings Search Input

设置页的 Skills、Hooks、Commands、MCP、Subagents 与插件市场搜索框统一复用
`SettingsSearchInput`：

- `Input size="lg"`
- 高度 `h-9`
- 圆角 `rounded-xl`
- 左侧搜索图标 `size-4`
- 输入内容左侧留白 `pl-9`
- 颜色、边框、Hover 与 Focus 状态继承标准 `Input`

页面只能通过容器 class 控制宽度和布局，不得覆盖上述几何样式。

Skills 与 Subagents 搜索框右侧的状态筛选器使用同样的 `h-9 rounded-xl`，保持同行控件
轮廓一致。
