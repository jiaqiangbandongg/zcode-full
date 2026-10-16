# Chat Empty Workspace Menu

> **当前状态**：本文描述 V4 空草稿与 workspace quick switcher 的当前行为。

The empty chat state title is `Start a new task in {workspace}`.
The workspace selector now sits in the composer context row above `ConversationComposer`, next to the Git branch switcher.

## Workspace List

- The menu includes a search input at the top.
- Search matches workspace display name, tab label, workspace path, and remote target text such as SSH host/user, WSL distro, or Docker container.
- Results keep the current workspace tab order; search never re-sorts matches.
- The menu shows at most the first 5 visible workspace matches both before and after searching.
- Disconnected remote workspaces remain hidden from this quick switcher because they cannot be entered immediately.
- The previous `Home` shortcut item is no longer shown.

## Add New Workspace

The action area is ordered as:

- `Open folder`
- `Remote connection`
- `Work without a project`

`Work without a project` ensures the stable backing workspace at `<dataBaseDir>/.zcode/workspace/default` and starts a draft there. The backing workspace is classified as `conversation`, excluded from project search/results, and displayed as `Select project` in the trigger. Selecting it repeatedly is a no-op.

When a real project is selected, the trigger reveals a separate close action on hover/focus. Closing only rebinds the unsent draft to the conversation backing workspace; it does not close the project tab or move an existing task. Workspace targets include path, optional identity, and purpose so remote workspaces with the same path remain isolated.

The selector can be reused by a surface that requires a real project. In that capability mode, both ways of entering the conversation backing workspace are absent: the trigger does not reveal the close action and the menu does not render `Work without a project`. The current workspace icon remains visible because no close action replaces it. The scheduled-task creation form uses this mode; ordinary conversation drafts keep the default behavior above.

`Open folder` reuses the same Open Folder entry function as the Open Workspace page. On desktop, the platform directory picker is configured with Electron `openDirectory` and `createDirectory`, so native dialogs that support creating folders can expose New Folder / Create Directory.
