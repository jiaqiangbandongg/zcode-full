# Windows Workspace Editor Menu

## Goal

Keep the workspace header editor menu on Windows aligned with the macOS Finder/editor menu experience.

## Behavior

- The first pinned option remains Windows Explorer, matching macOS Finder as the system file manager entry.
- The menu also lists installed editor apps such as VS Code, VS Code Insiders, Cursor, Trae, IntelliJ IDEA, PyCharm, WebStorm, GoLand, and CLion when their executables are present.
- Windows detection checks user-level installs, Program Files installs, JetBrains versioned install folders, and PATH command shims.
- PATH shims such as `code` are resolved back to the real app executable when possible, so the menu can use the application icon instead of a generic command icon.
- Clicking an editor opens the active workspace path with the selected app, and the selected app is persisted through the existing editor preference storage.
