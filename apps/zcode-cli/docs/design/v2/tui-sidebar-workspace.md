# TUI Sidebar Workspace

## Goal

The TUI sidebar should show the active workspace directory so users can verify
which project the current session will read, edit, run commands in, and use for
session resume lookups.

## Source Of Truth

- The CLI resolves the workspace directory through the existing `--cwd` handling
  before launching the TUI.
- `TuiOptions.workspaceDirectory` carries that resolved absolute path into the
  TUI.
- The TUI treats the value as display-only state. It must not call `process.cwd`
  or re-resolve paths, and it must not become a second owner for runtime
  working-directory state.

## Layout

- The sidebar `Run` section includes a `Workspace` row.
- Long paths are truncated to the existing sidebar row width so the sidebar
  remains fixed-width.
- Missing values render as `-`.

## Tests

- CLI tests assert the resolved `--cwd` value is passed into `runTui` as
  `workspaceDirectory`.
- TUI unit tests assert the sidebar renders the workspace row and truncates it
  through the existing row formatter.
