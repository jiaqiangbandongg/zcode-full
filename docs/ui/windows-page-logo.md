# Windows 页面左上角 Logo

## 范围

- Windows 桌面端的 `SettingsPage` 左上角补充应用 logo。
- 仅增加品牌标识，不新增点击行为，也不改变现有返回、打开工作区、设置分区等交互。

## 实现

- UI 新增 `packages/ui/src/WindowsTopLeftLogo.tsx`，统一复用 `App.tsx` 使用的明暗主题 logo 资源。
- `SettingsPage` 只在 `isWindowsDesktop` 条件下渲染该组件，继续保留顶部 `app-region:drag`。
