# Settings command list

The Commands settings list shows user and plugin commands without exposing storage details or repeating plugin-management guidance in each group or row.

- Rows display the command name, argument hint, description, relevant ownership metadata, and available controls. Workspace commands keep the Workspace label, while user commands do not repeat a User label; plugin commands keep the plugin-name label.
- User command rows do not display their backing directory path.
- Plugin command rows and the plugin group header do not display “Registered by a plugin. Edit it in the plugin.” The plugin group heading and plugin-name label already communicate ownership.
- Item descriptions use `text-ui-sm text-foreground-subtle` as secondary copy.
- Commands 的顶部搜索工具栏与 `Installed` 分组统一使用内容区显式的 `mt-6`（24px）；共享 Tabs 根节点不再额外提供 `gap-2`，避免搜索框到 New 按钮叠加成 32px。
- Command rows use the same `Terminal` icon as the Commands settings entry. Plugin artwork takes
  precedence when available; a missing or failed plugin image falls back to `Terminal`, not `Cable`.
- Workspace scope and plugin ownership use the shared scope treatment: a `rounded-full border-border bg-surface text-ui-sm` Badge with a 14px Folder or Cable icon.

## Command editor workspace scope

The Command editor uses the same concrete scope menu as Plugin MCP settings.

- A new Command defaults to User scope.
- The Scope menu lists User plus every currently open Workspace tab in the window.
- Workspace options are de-duplicated and selected by `workspaceIdentity?.trim() || workspacePath`; the actual command file path continues to use `workspacePath`.
- Choosing a Workspace changes only the current Command draft and its save target. It does not activate that Workspace tab or change the parent Commands list.
- Saving to another local or remote Workspace uses that Workspace's resolved Host service. Passing another path to the current Host is not a valid cross-Workspace save.
- The current Commands list is refreshed only when the saved target is the Workspace represented by that list. A save to another Workspace must not append the new command to the current list projection.
- Existing Commands keep a locked Scope. Editing must not move a Command between User and Workspace storage or between Workspaces.
- If a selected Workspace closes while creating, the draft falls back to User. If the owner Workspace closes while editing, the editor exits instead of changing the locked target.

```text
Command form scope
       |
       +-- User ----------------------> current list Host -> user commands directory
       |
       +-- Workspace key
              |
              +-- resolve open tab metadata
              |      workspaceIdentity / remoteSessionId / remoteTarget
              |
              +-- resolve target Host service
              |
              +-- write workspacePath/.zcode/commands
```

## Impact brief

| Field | Decision |
| --- | --- |
| Change layers | Presentation, option source, draft default, commit effect, persistence |
| UI surface | `CommandsSection` and `CommandForm` |
| Shared UI | `PluginScopeMenu` |
| Draft owner | Command form scope key |
| Commit sink | The selected Workspace Host's `commandsService` |
| Persistence | User or Workspace command directory; no format migration |
| Mode boundary | Local and remote Workspace tabs share scope semantics, but resolve different Host services |
| Out of scope | Command discovery order, slash-command runtime behavior, plugin command management, cross-window Workspace selection |

## Accepted cases

| Case | Setup | Action | Assertions |
| --- | --- | --- | --- |
| CMD-SCOPE-01 | Two open local Workspaces | Create and select Workspace B | B is shown by name; save writes B's path through the resolved target service; A's list is not polluted |
| CMD-SCOPE-02 | Two remote Workspaces with the same path and different identities | Open the scope menu | Both identities remain distinct scope keys and route to their own remote sessions |
| CMD-SCOPE-03 | New editor with a selected Workspace | Close the selected tab | Scope falls back to User without writing |
| CMD-SCOPE-04 | Existing Workspace Command | Open edit form | Actual owner is displayed, Scope is disabled, and save cannot migrate storage |
| CMD-SCOPE-05 | Existing Workspace Command owner closes | Close the owner tab | Editor exits and performs no write |
| CMD-SCOPE-06 | User scope | Save a new Command | Save omits project `workspacePath` and refreshes the current list |
