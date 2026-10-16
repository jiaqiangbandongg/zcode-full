# TUI Slash Command Suggestions

## Goal

The TUI should show slash command candidates directly above the prompt input
when the draft starts with `/`. The first version is a local typeahead surface:
it helps users discover and choose commands, while command parsing and execution
remain owned by the CLI command center.

## User Contract

- Typing `/` in the idle prompt opens a candidate list above the input box.
- Typing more command-name characters filters the list by command name or alias.
- Up and Down move the highlighted candidate and wrap at list boundaries.
- Enter on an active candidate submits that command.
- Tab on an active candidate completes the input to `/command ` without
  submitting, so the user can continue typing arguments.
- Tab without an active candidate is consumed and leaves prompt focus on the
  input. It must not switch focus to the transcript.
- Esc dismisses the candidate list and keeps the draft unchanged.
- Suggestions disappear once the draft no longer starts with a single slash
  command token, for example after a command and a following space.

## State Boundary

- TUI may keep transient suggestion selection state: current input, filtered
  candidate index, and whether the list was dismissed for the current draft.
- TUI must not parse or execute slash command business behavior. It only
  receives a read-only command surface and submits the selected command through
  the same `submitPrompt` callback used for normal input.
- CLI command center remains the source of truth for command usage, summaries,
  aliases, unknown-command behavior, and execution.

## Rendering

- Suggestions render above the prompt input in the action area.
- The prompt input remains visible even when suggestions are shown.
- The first version reserves footer rows instead of using an absolute overlay.
  This keeps rendering deterministic in Ink and avoids drawing over the
  transcript in small terminals.
- At most six suggestions are visible at once. When more commands match, the
  visible window follows the selected index.
- Each row contains the slash command and a short summary. Rows use word
  wrapping in narrow terminals and the panel height follows the rendered row
  count, so wrapped summaries must not overlap following commands.
- Row primary text uses the same emphasis as the TUI model popup model name:
  unselected commands use normal text color, selected commands use accent color.
  Summaries remain muted secondary text.
- Long unbreakable tokens may still be truncated by the terminal renderer, but
  ordinary command names and summaries should remain readable without horizontal
  overlap.

## Errors

- If no command surface is provided, no suggestions are shown and existing slash
  command handling is unchanged.
- If the user submits an unknown command after dismissing suggestions or typing
  a non-matching name, the existing command-center unknown-command response is
  shown. The input is still not sent to the LLM.
- Suggestions are hidden while a turn is busy because busy input may be queued
  for the active turn rather than routed through local command handling.

## Current Implementation Check (2026-05-08)

This surface is implemented in the TUI and wired to the CLI command center:

- `packages/tui/src/app-input.ts` owns query parsing, alias/name matching,
  selection clamping, and the six-row visible window.
- `packages/tui/src/app.tsx` keeps the selection state transient, hides it when
  the draft stops being a single slash token, and passes terminal width into the
  suggestion panel.
- `packages/tui/src/app-keyboard.ts` wraps Up/Down navigation, accepts Enter as
  command submission, accepts Tab as completion, and treats Esc as a local
  dismissal without changing the draft.
- `packages/tui/src/app-components.tsx` renders suggestions above the prompt and
  sizes the commands panel from width-aware wrapped row counts so the prompt
  stays visible and wrapped command rows do not overlap.
- `packages/cli/src/command-center.ts` exposes `listSlashCommandSuggestions()`
  from the same help entries used by command parsing and help output.
- `packages/cli/src/run.ts` passes that read-only command surface into `runTui()`.

Behavioral coverage exists in `packages/tui/tests/tui.unit.test.ts` for rendering
and Enter submission, Tab completion, and Esc dismissal. CLI wiring coverage
exists in `packages/cli/tests/cli.unit.test.ts`, which asserts the TUI receives
the command-center suggestion surface.

## Tests

- TUI renders slash command suggestions above the input when `/` is typed.
- TUI Up/Down changes the highlighted candidate and Enter submits it.
- TUI Tab completes the selected command without submitting and then allows
  arguments to be submitted normally.
- TUI Tab without an active suggestion is a no-op and leaves the input focused.
- CLI TUI wiring passes the command-center read-only command surface into TUI.
