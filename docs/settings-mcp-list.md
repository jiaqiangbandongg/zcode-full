# Settings MCP list

MCP server rows present ownership scope as compact metadata beside the server name.

- User and Workspace scope use the shared `Badge` treatment from Skill rows.
- The badge uses `rounded-full`, `border-border`, `bg-surface`, and `text-ui-sm`.
- A 14px leading icon identifies the scope: `UserRound` for User and `Folder` for Workspace.
- Scope labels remain the localized `User` / `Workspace` values.
- Configured MCP rows do not display their backing configuration directory path; location data remains available to configuration and editing logic.
- Runtime status dots and server names share a layout wrapper, but the name-only element owns `text-foreground`; status colors do not inherit from the server-name text style.
- Disconnected or unknown status dots use the tertiary foreground token `text-foreground-subtlest`; connected, connecting, and error retain their semantic colors.
- Hovering a status dot shows the reason. Configured servers use localized runtime explanations and prefer the actual server error when available; plugin servers reuse their resolved status description, including disabled and authorization-required explanations.
- Status-reason tooltips use `max-w-64` so longer explanations wrap within a compact 256px width.
- Item descriptions use `text-ui-sm text-foreground-subtle` as secondary copy.
- Tool-count metadata uses `text-ui-sm` in both configured and plugin-provided MCP rows.

Plugin-provided MCP rows show plugin ownership beside the MCP server name.

- Plugin ownership由所在分组标题表达，行内不重复显示 Plugin badge 或 marketplace。
- Plugin names use the canonical display-name formatter, including converting slug-like names into title-cased words.
- Plugin MCP 按稳定 `pluginId` 分组；同名不同 id 不合并。Plugin 分组按规范化 display name 排序，组内待处理项优先，其余保持声明顺序。
- Runtime status is represented only by the status dot and its hover explanation; plugin MCP rows do not repeat status as a text badge. Tool count remains separate metadata.
- Plugin MCP names reuse the configured-server status dot: connected is green, connecting is a yellow spinner, errors are red, disconnected or unknown is tertiary foreground, and authorization-required is a static yellow dot. Plugin-disabled is part of this status resolution and takes precedence over stale runtime state, always rendering a static tertiary-foreground dot.

Configured、Plugin MCP 共用一套失败展示：按 `failureKind` 国际化的摘要使用普通次要文字颜色，
错误状态只由 status dot 使用红色。原始 `error` 通过摘要后方的小型信息按钮按需在 Popover 中显示；
服务端 request id 已作为 ` - <requestId>` 后缀合并到这段可选择复制的详情文本，不再单独展示或提供第二个复制按钮。不得从 error 文本反解业务分类。
连接成功、重新连接或 workspace 切换必须清除旧诊断。

官方 Server MCP 的 JSON-RPC 错误码会先转换为稳定的设置页分类：`1006` 显示“未登录，请先登录
ZCode”，`3101` 显示“当前账号没有 Coding Plan，请先购买或配置 Coding Plan”；这两类提示不再
显示为笼统的“协议请求失败”。

MCP、Skills、Commands 共用 `SettingsResourceGroupHeader` 与 `SettingsResourceList`：分组间
`space-y-6`、组内 `space-y-4`、标题 `h-7 text-ui-base`、数量 `text-ui-sm`、列表
`rounded-xl bg-surface`，行间使用独立 `h-px bg-border/50`。
