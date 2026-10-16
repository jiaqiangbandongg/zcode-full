# Workspace Sidebar Scroll Mask

## 目标

当 workspace sidebar 的 workspace 列表出现纵向滚动条时，对列表滚动容器本身应用顶部和底部渐隐 `mask-image`，提示上下仍有内容可继续滚动。

## 当前行为

- 只有当 workspace 列表内容高度超过可视区域时，mask 才显示。
- 当列表顶部还有内容可向上回看时，顶部 mask 显示；滚回顶部后自动消失。
- 当列表底部还有内容可继续向下滚动时，底部 mask 显示；滚动到底部后自动消失。
- mask 仅作用在 workspace 列表滚动区本身，不影响底部账号/设置 footer。

## 实现位置

- 列表滚动容器与 mask：`packages/ui/src/WorkspaceSidebar.tsx`

## 实现说明

- 使用滚动容器的 `scrollTop / clientHeight / scrollHeight` 判断当前是否还能继续向上或向下滚动。
- 只有当内容仍可继续向上或向下滚动时，才为滚动容器保留对应方向的 `mask-image`；滚到边界后移除对应方向的 mask。
- 同时监听滚动容器和内容容器的尺寸变化，确保展开 workspace、任务数量变化、窗口尺寸变化后，mask 状态能同步更新。
