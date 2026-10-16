# Task List Context Menu

任务列表项新增右键菜单，统一承接 task 级快捷操作，避免把所有动作都堆到 hover 按钮或 Header more。

## 当前菜单项

- Pin task
- Rename task
- Archive task
- Mark as unread
- Open in Finder / File Explorer / File Manager
- Copy path
- Copy log path
- Go to config

## 交互说明

- `Pin task` 会持久化到 task 元数据，刷新或恢复后仍保持置顶；已置顶项菜单会显示 `Unpin task`
- 已置顶任务会常驻在列表顶部的独立 `Pinned` 分组里，不再和普通任务混排；折叠态下也始终可见
- `Rename task` 使用弹窗完成，支持 `Enter` 提交、取消关闭
- `Archive task` 会把任务标记为 archived，并从默认任务列表中隐藏
- 任务行 hover 时展示行内归档入口；首次点击进入二次确认态。确认态是显式等待用户决策的状态，鼠标移出任务行后仍保持确认按钮可见；点击任务行外空白处或按 `Esc` 取消确认态。
- `Mark as unread` 会持久化到 task 元数据；重新启动 app 后仍保留蓝点，打开该任务时再自动清除
- 重命名会持久化到 `tasks-index.sqlite` 并同步更新运行中 task 的内存 meta；恢复和快照回写必须遵守 [Task Title Authority](./task-title-authority.md)，避免 raw session snapshot 把手动标题还原成自动标题
- pin / unread / archive 也会同步更新运行中 task 的内存 meta，避免后续 session 持久化把旧状态写回来
- `Copy path` 指向 task 的持久化快照文件路径
- `Copy log path` 指向 task 对应的原生日志路径；ZCode Agent 使用按日期滚动的结构化 JSONL 日志
- `Go to config` 会复用当前持久化的编辑器偏好；如果无法直接用编辑器打开，则回退到文件管理器
