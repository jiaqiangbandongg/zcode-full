# TUI Sidebar Session Modified Files

## Goal

The TUI sidebar should show a compact, current-session summary of files changed
by successful file mutation tool calls. Users should be able to see which files
the agent touched and the accumulated addition/deletion counts without scrolling
back through the transcript.

The sidebar should also let users collapse the modified-files and API sections
independently so long-running sessions can reclaim vertical space.

## Source Of Truth

- The modified-file summary is a live TUI projection derived from
  `tool_call_result.payload.result.display`.
- Only safe `file_diff` display payloads are counted. The TUI must not parse
  model-visible tool result text, inspect tool internals, call git, or read the
  filesystem to produce this summary.
- File paths are formatted with the same workspace-relative display helper used
  by tool transcript paths.
- Counts are accumulated per display path for the current TUI session.
- If a session reset or resume result clears the session projection, the
  modified-file summary and duplicate tool-call guard are cleared too.
- Duplicate result events for the same `toolCallId` must not double count a
  file change.

## Rendering Contract

- The sidebar includes a `Modified Files` section after `Run`.
- Section titles are still sourced from localized copy. In Chinese UI the
  modified-files title remains `变更文件`; only the marker changes.
- When expanded, each row shows a truncated path plus `+N` additions and `-N`
  deletions aligned to the right.
- Additions use the existing accent color. Deletions use the existing danger
  color. Paths use muted text.
- Empty expanded state renders a short muted placeholder.
- The list is bounded; if more files were modified than fit the sidebar slice,
  a muted `more` row shows the remaining count.
- The existing `APIs` section keeps its current rows when expanded.
- Collapsed sections render only their header.
- Collapsible section headers use a filled triangle marker: `▼` when expanded
  and `▶` when collapsed.
- The header label uses the normal sidebar text color and bold weight so it
  reads as an interactive row rather than a diagnostic counter.

## Keyboard Contract

- `Ctrl+X` keeps the sidebar leader behavior.
- `Ctrl+X B` toggles the whole sidebar.
- `Ctrl+X M` toggles the `Modified Files` section.
- `Ctrl+X A` toggles the `APIs` section.
- Section expansion state is local TUI presentation state. It is not persisted
  and does not affect runtime, session, tool, ZCode app-server, storage, permission, or
  provider contracts.

## Mouse Contract

- Clicking the `Modified Files` section header toggles only that section.
- Clicking the developer-mode `APIs` section header toggles only that section.
- Sidebar section clicks stop event propagation so they do not trigger the app
  shell mouse handler that returns focus to the prompt input.

## Tests

- TUI event tests cover aggregation from `file_diff` display payloads,
  workspace-relative paths, and duplicate `toolCallId` suppression.
- Sidebar component tests cover expanded and collapsed modified-file/API
  rendering, count colors, empty state, and bounded `more` rows.
- Sidebar component tests cover section header click handlers.
- Shortcut tests cover `Ctrl+X M` and `Ctrl+X A` in addition to the existing
  sidebar toggle path.
