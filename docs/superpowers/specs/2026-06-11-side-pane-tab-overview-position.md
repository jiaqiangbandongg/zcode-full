# Side Pane Tab Overview Entry Position

## 背景

Side pane 的 tab 条已有一个用于搜索当前打开标签和最近关闭标签的 overview 入口。入口原本位于 tab 条右侧工具区，图标为搜索类图标，和“新增标签”按钮的视觉层级不够贴近 tab 导航本身。

## 目标

- 将 tab overview 入口移动到 side pane tabs 的左侧，让它成为 tab 导航的前置入口。
- 将入口图标改为 `ChevronsDownIcon`，表达“展开/查看标签列表”的语义。
- 保持原有搜索、切换、关闭、恢复最近关闭 tab 的行为不变。
- Tabs 横向溢出时，根据当前滚动位置只在仍可继续滚动的一侧显示渐变 mask。

## 非目标

- 不改变 side pane tab 的数据结构。
- 不改变新增标签菜单的位置和可选项。
- 不改变移动端 side pane 布局语义。

## 验证

- TypeScript 类型检查通过。
- lint 通过。
- 入口仍使用 `sidePane.tabOverview` / `sidePane.searchTabs` 等现有国际化文案。
