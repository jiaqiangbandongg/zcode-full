# Settings Hook list

Hooks 保持独立的设置入口，不并入插件页。页面复用 Plugins、MCPs、Skills、Commands 的
Scope、搜索、分组标题、列表容器和空状态信息架构。

## Scope 与来源

- 顶部为 `<Scope> | Hooks {count}`，右侧为搜索框。
- Scope 使用共享 `PluginScopeMenu`：User 展示 user 配置及 user 插件 Hook；Workspace 展示
  当前 workspace 配置、兼容来源及该 workspace 安装插件提供的 Hook。
- `workspaceIdentity?.trim() || workspacePath` 用于工作区状态隔离，`workspacePath` 只用于读写路径。
- Workspace Hook 允许管理，但按 `docs/hooks-runtime-contract.md` 的安全契约不进入 Agent runtime。
- 新建表单继承父层 Scope；编辑表单显示持久化 Scope 且不可迁移。Scope 位于表单卡片右上角，
  使用 `Scope + PluginScopeMenu` 的横向结构并向右对齐，与 MCP、Command 表单一致。

## 分组

`New` 位于 `Installed` 分组标题右侧；标题行复用 Commands 的 `flex flex-wrap items-center justify-between gap-3` 布局，不使用固定高度。搜索后仅展示包含可见行的分组，不保留
`Installed 0` 等空标题；未搜索且 Installed 为空时保留该分组作为新建入口。

1. `Installed`：当前 Scope 下由 ZCode 直接管理的 Hook。
2. 每个插件独立分组：标题使用插件规范化名称，行只读，启停仍由插件设置管理。
3. `Legacy`：`.agents` / `.claude` 兼容来源，提供 Import 操作。

`Installed` 与 `Legacy` 是界面分组名称，必须通过 `settings.hooks.group.*` 国际化；插件分组标题来自插件名称，不翻译。Hook Event 是配置协议标识，也保持原值。

插件 Scope 元数据未知时，Hook 在 User 和 Workspace 中均保留，并显示“作用域未知”，避免
伪造来源或静默丢失。

## Hook item

- 主标题是 Hook Event（例如 `PreToolUse`），不再以 matcher 作为标题。
- 第二行展示命令或脚本摘要，单行截断，使用 `font-mono text-ui-sm text-foreground-subtle`。
- 直接配置和 Legacy 使用与设置菜单一致的 `Anchor` 缺省图标；插件 Hook 使用对应插件图标，
  插件图标不可用时同样回退到 `Anchor`。
- 直接配置右侧显示开关，点击整行进入编辑；Legacy 显示 Import；插件 Hook 只读且不显示开关。
- Scope 和插件名称不在行内重复展示；matcher、runner 等细节留在编辑或只读详情语义中。
- 列表使用 `rounded-xl bg-surface`，行间分割线是独立 `h-px bg-border/50` 元素。
- 无内容、loading、搜索无结果统一使用透明背景的虚线容器。

修改 Hook 后仍关闭未使用的 deferred draft session；已经运行或历史 session 继续使用启动时
捕获的快照。
