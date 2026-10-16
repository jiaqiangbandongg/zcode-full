# 二次确认弹窗

## 目标

- 为 `packages/ui` 提供一个全局可复用的二次确认弹窗。
- 先覆盖两个高风险操作：删除 task、移除 project。

## 实现

- `packages/ui/src/store/confirmDialogStore.ts` 用 Zustand 管理单例确认请求，调用侧通过 Promise 等待结果。
- `packages/ui/src/ConfirmDialog.tsx` 负责渲染弹窗，布局和按钮区对齐 `z-work` 的确认弹窗样式。
- `packages/ui/src/Root.tsx` 在根节点挂载 `ConfirmDialogHost`，保证 desktop、web、本地、remote 都走同一套 UI 逻辑。

## 接入点

- `packages/ui/src/TaskList.tsx` 删除 task 前先弹确认框。
- `packages/ui/src/WorkspaceSidebar.tsx` 移除 project 前先弹确认框。

## 交互约束

- `Esc` 取消，`Enter` 确认。
- 关闭 project 只移除侧边栏项目，不影响磁盘文件。
