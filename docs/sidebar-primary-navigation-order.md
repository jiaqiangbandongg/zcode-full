# Sidebar Primary Navigation Order

## 背景

WorkspaceSidebar 顶部主导航承载新建任务、Command Center 搜索、自动化和 Plugins 设置入口。自动化入口属于用户高频查看的任务型能力，在支持该能力的端侧应紧邻 Search，Plugins 入口固定放在自动化下方。手机 `/remote` 不承载 Automations，只保留 Plugins 入口。

## 规范

桌面端和普通 Web 的顶部主导航固定顺序为：

```text
New Task
  |
  v
Search / Command Center
  |
  v
Automations / 自动化
  |
  v
Plugins / 插件（定位到 `plugins` 设置分区）
  |
  v
Workspace task view switcher
```

手机 `/remote` 的顶部主导航顺序为：

```text
New Task
  |
  v
Search / Command Center
  |
  v
Plugins / 插件（定位到 `plugins` 设置分区）
  |
  v
Workspace task view switcher
```

两种布局的入口视觉样式、主题 token、按钮尺寸均与现有 `WorkspaceSidebar` 主导航按钮保持一致。
