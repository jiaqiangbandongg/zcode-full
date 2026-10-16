# Workspace Header Structure

更新 `packages/ui` 工作区 header 为左右分区结构：

- 左侧：任务名称、项目名称、编辑器快捷按钮、更多菜单
- 右侧：编辑器快捷按钮、终端切换按钮、侧边面板切换按钮

设计约束：

- 任务名作为主标题，项目名作为次级信息
- 终端和浏览器入口改为 icon-only，视觉对齐侧边栏折叠/展开按钮
- 编辑器快捷按钮显示最近一次选中的编辑器图标，主按钮直接打开当前 workspace，箭头按钮下拉切换并持久化选择；文件管理器入口继续保留在更多菜单
- Workspace header 不展示 status panel 切换按钮；status panel 的展开 / 收起由面板自身的收起按钮和 mini 摘要行承担
- 新建任务草稿态（`activeTaskId === null`）不展示完整 Workspace header；草稿态主输入区继续独占顶部注意力，只在桌面端轻量标题栏右上角保留帮助入口和 Terminal 切换入口，直到首发创建出稳定 task 后再恢复 header、workspace 上下文和 task 菜单
- 草稿态 Terminal 入口复用会话态同一按钮、快捷键提示、选中态和切换行为；macOS/普通桌面放在帮助入口旁，Windows/Linux 放在自绘合并菜单旁。手机 Web 远控不增加该桌面标题栏入口
- 侧边面板切换按钮只保留图标，不展示 Git `+added -removed` 变更摘要；Git 变更摘要和提交 / 推送入口统一收敛到 Chat status panel 的 Git Tools
- 更多菜单集中提供文件管理器、路径、任务与链路 ID 的复制能力，便于排查问题
- “Open provider config” 菜单项使用纯文本文案，复用右上角当前选中的外接应用，不单独维护 editor 状态
- Remote 窗口行为暂不在此处覆盖（本轮仅本地桌面窗口）

当前菜单项：

- macOS: Open in Finder
- Windows: Open in File Explorer
- 其它平台: Open in File Manager
- Copy path
- Copy task ID
- Copy trace ID
- Copy session ID
- Copy log path
- Open provider config
