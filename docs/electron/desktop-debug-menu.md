# Desktop 调试入口

桌面端把开发和诊断相关的入口统一收口到 `Help` 菜单，避免调试能力分散在多个顶层菜单里。

当前 `Help` 菜单里的调试入口包括：

- `Toggle Developer Tools`
- `Resource Manager`（资源管理器，见 `docs/electron/resource-manager.md`）

这样调整后，开发排查时只需要从一个固定位置进入对应工具。
