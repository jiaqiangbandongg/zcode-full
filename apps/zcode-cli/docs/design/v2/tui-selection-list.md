# TUI Selection List

ZCode TUI needs a reusable list interaction for commands that choose an existing session or a workspace checkpoint. The first version is intentionally local to the TUI command flow and does not change ZCode app-server or non-interactive prompt behavior.

## Current Implementation Status

Status as of 2026-05-27: the P0 reusable TUI selection list is implemented and
covered for the session/checkpoint command flows described below. Resume-session
and rewind-to-checkpoint pickers now opt into the composer suggestion placement,
matching the `/model` interaction: the option list is rendered above the input
box while the composer remains visible.

Implemented behavior:

- Bare `/resume` opens a session picker when the command-center dependency
  provides `listSessions`; selected rows submit explicit `/resume <sessionId>`
  commands.
- Bare `/rewind` and `/fork` open checkpoint pickers when the active app exposes
  `listCheckpoints`; selected rows submit explicit `/rewind <checkpointId>` or
  `/fork <checkpointId>` commands.
- Resume-session and rewind-to-checkpoint pickers declare
  `placement: "composer"` and render in the same composer-adjacent area used by
  `/model` suggestions. Fork, login, goal replacement, and other selection
  flows keep the default action-panel placement unless they explicitly opt in.
- Explicit `/resume <sessionId>`, `/continue`, `/rewind latest`,
  `/rewind <checkpointId>`, `/fork latest`, and `/fork <checkpointId>` still use
  the normal command paths and bypass the picker.
- The TUI renders transient selection state, supports filtering, arrow/page
  navigation, backspace, `Ctrl+U`, `Enter`, `Esc`, empty states, and disabled-row
  status messages.
- Selection payloads may include an initial selected index so command-owned
  state can open with the active row highlighted without the TUI owning the
  business rule.
- Individual pickers may opt out of filtering when the option set is small and
  fixed. A non-filterable picker does not show the filter line, ignores typed
  filter keys, and keeps only navigation, selection, and cancellation keys.
- Individual rows may declare a pending view for long-running local commands.
  Selecting such a row replaces the picker contents with the pending message
  instead of returning to the composer. `Esc` cancels the in-flight command and
  restores the same option list.
- Runtime checkpoint summaries are exposed through the bootstrap app facade and
  return newest-first workspace checkpoint rows with best-effort user-message
  previews.
- Rows render the primary label on the left and secondary/meta explanation on a
  muted right-aligned column so explanations do not compete visually with the
  active choice label.

Implementation anchors:

- `packages/cli/src/command-center.ts`: builds `TuiSelection` payloads for
  `/resume`, `/rewind`, and `/fork` and keeps selected rows command-shaped.
- `packages/tui/src/types.ts`: declares `TuiSelection` and `TuiSelectionItem`
  as the UI-facing data contract.
- `packages/tui/src/app-view.tsx`: routes composer-placed selections into the
  composer suggestion stack instead of replacing the input area.
- `packages/tui/src/app-selection-keyboard.ts`: owns selection keyboard
  handling, filtering state, cancellation, disabled-row handling, and command
  submission.
- `packages/tui/src/app-selection-panel.tsx`: filters and renders selection
  rows, empty states, and selection windows.
- `packages/core/src/runtime/methods/workspace-checkpoints.ts`: provides
  newest-first checkpoint summaries for picker data.
- `packages/bootstrap/src/index.ts`: exposes `listCheckpoints` through the app
  facade after resume preparation.

Remaining work:

- No ZCode app-server-specific picker protocol is introduced; remote clients should keep
  using explicit commands or their own UI projection.
- The picker only covers persisted root sessions and workspace checkpoints. It
  does not yet provide all-message navigation or arbitrary conversation rewind.

## Scope

The reusable selection list covers:

- `/resume` in the TUI: choose a persisted root session.
- `/rewind` in the TUI: choose a workspace checkpoint to restore in the current session.
- `/fork` in the TUI: choose a workspace checkpoint to fork from.

Explicit commands remain scriptable and bypass the picker:

- `/resume <sessionId>`
- `/continue`
- `/rewind latest`
- `/rewind <checkpointId>`
- `/fork latest`
- `/fork <checkpointId>`

If the TUI has no list data source, commands fall back to the existing behavior. This keeps the feature usable in tests, stripped-down clients, and non-interactive command-center consumers.

## UI Contract

The picker is a transient TUI interaction with two supported placements:

- Default selections are rendered in the action panel.
- `placement: "composer"` selections are rendered above the input box in the
  same stack as `/model`, `/mode`, and `/effort` suggestions. The input box
  remains visible, but keyboard focus stays with the active picker until the
  user selects or cancels it.
- `Up` and `Down` move the active row.
- `PageUp` and `PageDown` jump several rows.
- The rendered row window follows the active row, so moving past the last
  visible row scrolls the list instead of hiding the active choice.
- Filterable pickers allow typing to filter visible rows by id, title, path,
  preview, and metadata.
- `Backspace` edits the filter for filterable pickers.
- `Ctrl+U` clears the filter for filterable pickers.
- `Enter` submits the selected row's explicit command.
- `Esc` cancels the picker and returns to the normal input box.
- In a pending row view, `Esc` cancels the active command and returns to the
  previous picker options instead of closing the picker.
- Rows may declare an inline input view. Selecting such a row replaces the
  picker contents with that input while keeping the same panel open. `Enter`
  submits the row command plus the entered value, and `Esc` cancels the inline
  input and returns to the previous picker options.

Rows are command-shaped. Selecting a row submits a normal slash command such as `/resume sess_...`, `/rewind checkpoint_...`, or `/fork checkpoint_...`. This preserves auditability: a user or agent can copy the exact command and reproduce the action without TUI state.

## Data Contract

Session rows are produced from `SessionStorePort.listSessions({ directory, roots: true })` through bootstrap. The TUI command center receives only display-ready session summaries and does not read storage directly.

Checkpoint rows are produced by the active runtime from session events. The runtime returns workspace checkpoints sorted newest first, with optional user-message preview when session message storage is available. The TUI command center does not parse raw event payloads.

Checkpoint rows represent file restore points, not arbitrary conversation messages. Later versions may add all-message navigation, but P0 only enables rows that have a workspace checkpoint artifact.

## Error Behavior

- Empty session lists show an empty picker state with an explanatory message.
- Empty checkpoint lists show an empty picker state with an explanatory message.
- Selecting a disabled row is ignored with a status message.
- Composer-placed selections are still transient command UI; `Esc` closes the
  picker and returns to the normal composer without submitting a command.
- Non-filterable pickers keep their full option list visible; typing ordinary
  characters while such a picker is active has no effect.
- A stale selected id still goes through the explicit command path; runtime returns the existing structured error or user-facing unavailable message.

## Tests

Implemented coverage includes:

- `packages/cli/tests/cli.unit.test.ts`: command center returns a session picker
  for bare `/resume` when a session list provider exists.
- `packages/cli/tests/cli.unit.test.ts`: command center returns checkpoint
  pickers for bare `/rewind` and `/fork` when checkpoint data exists.
- `packages/cli/tests/cli.unit.test.ts`: explicit ids and `latest` bypass
  pickers through the normal command paths.
- `packages/tui/tests/tui.unit.test.ts`: TUI renders a picker, filters rows, and
  submits the selected explicit command.
- `packages/tui/tests/tui.unit.test.ts`: TUI initializes picker state from a
  command-provided selected index.
- `packages/tui/tests/tui-app.test.ts`: composer-placed selections render above
  the prompt input instead of replacing it.
- `packages/core/tests/runtime-tool-loop.test.ts`: runtime checkpoint listing
  returns workspace checkpoint summaries from persisted checkpoint events.
