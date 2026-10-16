# TUI Input Active Status

## Goal

The TUI should reserve a small active-turn affordance and context meter row
below the prompt input frame. While the agent is working, the line shows the
same braille spinner used beside `Thinking`, followed by
`esc to interrupt` on the left, and the current context meter on the right. When
the turn settles, the active hint disappears; if context usage is known, the
right-side context meter may remain visible on the same row. If neither the
active hint nor context meter is available, the row remains mounted as an empty
one-row spacer so the composer height does not flash.

## Scope

- Render the active hint only in the normal composer area, outside the prompt
  input frame.
- Use the TUI controller `busy` state as the active hint source of truth and the
  existing TUI session projection as the context meter source of truth.
- Keep this row separate from the sidebar status projection. It must not mirror
  sidebar status details, last event text, token usage, tool details, or error
  history.
- Keep the prompt input title and in-frame metadata row stable while busy. The
  input frame must not append an additional active-turn phrase such as `current
  turn running`, and it must not render `esc to interrupt` inside the border.
- Keep approval, clarification, selection, and workflow panels in their existing
  replacement slots.
- Do not add environment variables, runtime events, provider behavior, storage
  schema, or ZCode app-server protocol changes.

## Rendering Contract

The active hint is part of a one-line OpenTUI presentation component:

- Always mounted below the input frame in the normal composer area.
- Reserves exactly one terminal row even when `busy` is false and no context
  meter is available.
- The spinner and interrupt hint are visible on the left side when `busy` is
  true.
- The context meter is visible on the right side when context usage is known.
- Left aligned below the input pane.
- Must not render inside the input frame or share the input metadata row.
- Contains one animated braille spinner cell and a compact hint label.
- The hint label is `esc to interrupt`.
- The context meter renders as `<used> (<percent>)`, for example `24.1K (2%)`.
- It is visually separate from the model/provider/thought metadata from
  `tui-input-session-panel.md`.

The spinner is a
single-cell braille spinner cycling through `⠋`, `⠙`, `⠹`, `⠸`, `⠼`, `⠴`,
`⠦`, `⠧`, `⠇`, and `⠏`. The animation may use component-local timer state.
That state is purely presentational: it must not own session state, perform I/O,
call providers, or mutate runtime status. The timer is disposed when the active
spinner content unmounts after the turn ends.

The row should reserve only one terminal row outside the input frame whether it
is empty, showing the active hint, showing the context meter, or showing both.
It should not add another border or panel chrome, because the input box already
owns the composer frame. The input metadata width budget must not include the
active hint or context meter, because neither is rendered inside that row.

## Failure Behavior

If the turn fails, is cancelled, or completes, the same cleanup path that clears
`busy` removes the active hint. If the animation timer cannot tick, the hint may
keep a static spinner frame while still showing the interrupt label.

## Tests

- Unit tests assert that the standalone active row renders a deterministic
  braille frame and `esc to interrupt` while busy.
- Unit tests assert that the standalone active row reserves one row while idle
  and empty.
- Unit tests assert that the standalone active row renders the context meter on
  the right side and can render it without the busy hint.
- Unit tests assert that the in-frame composer status row does not render the
  active hint or context meter while busy.
- Unit tests assert that the spinner frame sequence uses the expected
  braille glyphs.
- Composer tests assert that the shared composer status line is embedded in the
  prompt input while idle and while a turn is active.
