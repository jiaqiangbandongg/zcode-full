# Platform Primary Keyboard Shortcuts

## Background

ZCode uses a cross-platform primary shortcut concept for workspace-level commands such as command center, task find, sidebar, terminal, side pane, and navigation. The label layer already displays macOS shortcuts with Command and Windows/Linux shortcuts with Ctrl, but the runtime matching used to accept both `metaKey` and `ctrlKey` on every platform.

On macOS this makes `Ctrl+F`, `Ctrl+B`, `Ctrl+K`, and related Emacs-style editing shortcuts trigger ZCode workspace commands instead of reaching the focused text editor or system text binding.

## Spec

- Apple platforms (`Mac`, `iPhone`, `iPad`, `iPod` from `navigator.platform` or user agent) treat Command (`metaKey`) as the only primary modifier.
- Non-Apple platforms treat Ctrl (`ctrlKey`) as the only primary modifier.
- Primary shortcuts must not match when both Command and Ctrl are pressed together.
- Primary + Shift and Primary + Alt variants follow the same platform-specific primary modifier rule.
- Explicit Ctrl-only shortcuts remain unchanged for now. They are intentionally separate from primary shortcuts and can be migrated in a later shortcut policy pass.

## Current Scope

- Workspace-level renderer shortcuts in `useAppKeyboard`.
- Task search numeric selection shortcuts using primary modifier matching.
- Web-only root fallbacks for new task and open workspace.

Desktop Electron menu accelerators continue to use `CmdOrCtrl`, which Electron maps to Command on macOS and Ctrl on Windows/Linux.
