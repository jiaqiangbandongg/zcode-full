# 桌面端输入框右键菜单国际化 Spec

## 背景

桌面端输入框的右键菜单由 Electron 主进程监听 `context-menu` 事件后动态弹出。菜单项目前只设置了 Electron `role`，没有设置 `label`，因此文案由 Electron/操作系统默认语言决定，可能与 ZCode 当前应用语言不一致。

## 目标

- 桌面端可编辑文本输入框的右键菜单（撤销、重做、剪切、复制、粘贴、删除、全选）使用当前应用 locale 的文案。
- 保留 Electron `role` 和 `editFlags`，不改变原生编辑行为及禁用状态。
- 应用切换语言后，下一次打开右键菜单立即使用新语言，不需要重启窗口。

## 非目标与边界

- 不修改手机 Web/远程 Web 的浏览器原生右键菜单；该菜单由浏览器控制，应用无法直接注入应用文案。
- 不把输入框右键菜单改造成 React/DOM 自定义菜单。
- 不改变选中文本、内置浏览器或终端的其他右键菜单。

## 实现约束

- 菜单标签复用 `packages/shared/src/desktopMenu.ts` 的桌面菜单 locale 表。
- 右键菜单创建时通过 locale getter 读取最新应用语言，而不是在窗口创建时固化语言。
- `Delete` 补充独立的桌面菜单 message id，确保右键菜单中的全部操作都有中英文文案。

## 验收标准

1. `zh-CN` 下编辑输入框右键菜单显示：撤销、重做、剪切、复制、粘贴、删除、全选。
2. `en-US` 下显示：Undo、Redo、Cut、Copy、Paste、Delete、Select all。
3. 各菜单项的 `role` 与 `enabled` 状态保持现有 `ContextMenuParams.editFlags` 结果。
4. locale getter 在弹出菜单时读取，因此切换语言后无需重建 BrowserWindow。
