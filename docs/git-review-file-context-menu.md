# Git Review File Context Menu Spec

## 背景

Git 审查面板的文件行目前只能展开 diff。用户在审查某个文件时，常见的下一步是定位真实文件、复制路径，或者回到左侧文件树查看它在 workspace 中的位置。文件树已经提供类似能力，本改动把同一套文件操作接入 Git 审查文件行。

## 用户行为

- 在 Git 审查文件行右键时展示上下文菜单。
- 菜单包含：在系统文件管理器中显示、复制文件路径、在文件树中显示。
- 点击文件行本身仍保持现有展开/收起 diff 行为。

## 模块边界

- `GitPaneChangeCard` 只负责展示文件行和菜单，不直接访问 Electron、`window.zcode` 或文件树状态。
- `GitPane` 负责把 `GitPaneFileChange` 解析成文件动作目标，包括绝对路径、workspace 相对路径、deleted 状态。
- 通用文件动作封装在 UI hook 中，统一处理 clipboard、系统文件管理器、日志和 toast。
- `WorkspaceShellLayout` 只接收“在文件树中显示”的 intent，并复用现有 `fileTreeOpenRequest` 打开左侧文件树。
- 平台能力继续通过 `IPlatformService`，UI 层不直接调用桌面 preload。
- “系统文件管理器”能力由上层显式传入本地桌面端能力位，hook 内再叠加远程 workspace / deleted 状态判断，避免普通 Web 或手机 Web 误触本机文件管理器路径。

## 路径规则

- 真实文件操作路径使用 `change.path`；如果不是绝对路径，则用 `workspacePath` 拼接。
- “在系统文件管理器中显示”对文件目标打开父目录，对目录目标打开目录自身；不要把文件路径直接交给系统默认打开逻辑。
- 展示路径继续使用 `change.workspaceRelativePath`。
- workspace 隔离语义沿用 `workspaceIdentity?.trim() || workspacePath`，不把 identity 当作实际文件路径。

## 平台边界

- macOS 本地桌面显示“在 Finder 中打开”。
- Windows 本地桌面显示“在资源管理器中打开”。
- Linux 本地桌面显示“在文件管理器中打开”。
- 普通 Web、手机 Web 远控、远程 workspace 禁用系统文件管理器项，只保留复制路径和文件树定位；禁用依据不能只看 `workspaceRemoteSessionId`，还必须要求本地桌面端能力位为 true。
- deleted 文件保留复制路径和文件树定位，禁用系统文件管理器项，避免尝试打开已不存在的本地文件。

## 验证

- 本地桌面：右键文件行可以复制路径、在文件管理器中显示、跳转文件树。
- 远程 workspace / Web 远控：系统文件管理器项禁用，复制路径和文件树定位可用。
- 深层路径：文件树应自动展开父目录并滚动到目标文件。
- 执行 `pnpm typecheck` 与 `pnpm lint`。
