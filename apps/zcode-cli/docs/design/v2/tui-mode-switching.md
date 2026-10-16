# TUI Mode Switching

## Goal

The terminal UI must make the active collaboration mode visible and allow the user to switch mode without restarting the session. The mode controls permission behavior for later tool calls, so switching it is a session configuration change, not a prompt sent to the model.

## User Contract

- The TUI session panel always includes the current mode on the same metadata
  row as model and thought level, formatted as
  `mode: <mode> | model: <model> | thought: <level>`.
- The TUI supports `/mode` commands entered in the normal prompt box:
  - Typing `/mode` or `/mode <query>` in the composer opens an inline popup above
    the input, matching the `/model` popup interaction. The input box remains
    visible and focused.
  - Pressing `Enter` while the popup is active submits the highlighted row as an
    explicit `/mode <mode>` command; `Tab` only completes the highlighted command
    into the input.
  - Submitting bare `/mode` from a client without the composer popup shows the
    current mode and available modes as text.
  - `/mode plan`, `/mode build`, `/mode edit`, and `/mode yolo` switch subsequent turns to that mode.
  - `edit` mode automatically accepts file editing tools, while non-edit or high-risk operations continue through the same confirmation behavior as `build`.
- The normal prompt box title displays only the current mode label, formatted as
  `<Mode>`. The displayed mode label is title-cased for `Plan`, `Build`,
  `Edit`, and `Yolo`; the runtime enum remains lowercase.
- The prompt box title reserves one blank cell on each side of the title text so
  it does not touch the border. The prompt box uses OpenTUI's rounded border
  style.
- `Shift+Tab` in the normal composer cycles through the switchable TUI modes in
  the same order advertised by the `/mode` picker:
  `plan -> build -> edit -> yolo -> plan`. This
  shortcut performs the same session configuration update as `/mode <mode>` and
  must not insert text into the draft or submit a model prompt.
- Entering `plan` mode records the mode the session was in beforehand, and
  leaving `plan` mode (whether the model approves a plan via `ExitPlanMode`, or
  the user manually switches to another mode) restores that recorded mode.
  Plan mode is therefore a temporary overlay: after a plan is approved the
  session returns to the exact mode the user was working in (e.g. `yolo` or
  `edit`), not a fixed fallback. See "Plan Mode Restore Contract" below.
- `auto` remains a reserved runtime mode. The TUI may display it if it was loaded from configuration or another client, but it does not offer switching into `auto` until the mode has implemented runtime semantics.
- A `/mode` command while a turn is running is still routed by the existing
  busy input behavior. The `Shift+Tab` shortcut is a local session
  configuration action and may switch mode while output is active; the new mode
  affects later permission checks and turns.
- After a mode switch, the TUI updates the header immediately and returns a system-style transcript line confirming the new mode.
- The `/mode` picker is command-shaped: every row submits an explicit
  `/mode <mode>` command. The current mode is marked in the row metadata, and
  unsupported runtime modes such as `auto` remain visible only as the current
  mode text.

## Module Boundary

- TUI does not parse the slash command. It stores and renders mode state from `TuiOptions.initialMode` and `TuiSubmitPromptResult.mode`.
- The shortcut uses a narrow `TuiOptions.setMode` callback supplied by the CLI
  shell. The TUI owns only the presentation projection and the deterministic
  cycle order; CLI/bootstrap still owns the session mutation.
- CLI command-center owns `/mode` parsing and dispatch. This keeps the command policy beside `/compact`, `/resume`, and `/skill`.
- Bootstrap exposes the app's active mode through a narrow app-level contract. The command-center must not reach into runtime internals other than this explicit API.
- Core runtime mode changes go through `AgentRuntime.updateConfig({ mode })`, so the existing permission executor callback observes the new value on subsequent tool checks.

## Plan Mode Restore Contract

Plan mode is a temporary overlay on top of the user's working mode. The session
must remember the mode it had before entering `plan` and return to it on exit.

- The "pre-plan mode" is held on the runtime as `prePlanMode`
  (`Exclude<CollaborationMode, "plan">`). It is the single source of truth for
  where to return after plan mode.
- Maintaining `prePlanMode` is centralized in the one and only mode write point,
  `AgentRuntime.updateConfig({ mode })`:
  - Switching into `plan` from a non-plan mode records `prePlanMode = <current
    mode>`.
  - Switching out of `plan` into any other mode clears `prePlanMode`, because the
    overlay has been resolved and no stale "return target" should survive.
  - Repeated `plan -> plan` writes do not overwrite an existing `prePlanMode`.
- `ExitPlanMode` (model-driven plan approval) restores `prePlanMode` if present,
  otherwise falls back to `build`. The fallback only applies when no prior mode
  was recorded (e.g. a session created directly in `plan`).
- Because every path that mutates the mode — the `ExitPlanMode`/`EnterPlanMode`
  tools, the `/mode` command, `Shift+Tab`, and any client `setMode` RPC — flows
  through `updateConfig`, manual and tool-driven entry into plan mode behave
  identically. This fixes the prior bug where manually entering plan mode (which
  bypassed the tool path) left `prePlanMode` unset, so `ExitPlanMode` always fell
  back to `build` ("confirm before changes") instead of the user's real previous
  mode.

## Errors

- Unknown mode values return a normal command response instead of throwing.
- If the app is not created yet, `/mode <mode>` stores the requested mode override; the next session is created with that mode.
- If the app already exists, `/mode <mode>` updates the runtime config in-place.

## Tests

- TUI renders the initial mode and updates the header when a prompt result includes a new mode.
- TUI renders the mode in the prompt input title, including localized input
  labels.
- TUI `Shift+Tab` calls the injected mode setter, advances from `build` to
  `edit`, and does not change the draft.
- TUI composer parses only the transient popup state for `/mode`, and converts
  highlighted rows to explicit `/mode <mode>` commands before submit.
- Command-center parses `/mode`, reports the current mode for the bare command,
  rejects unsupported values, and updates mode through its injected controller
  for explicit `/mode <mode>` commands.
- CLI TUI wiring passes the initial mode and shortcut mode setter to TUI and
  lets both `/mode` and `Shift+Tab` affect the app runtime config.
- `updateConfig` records `prePlanMode` when switching a non-plan mode into
  `plan`, and clears it when switching out of `plan` to another mode.
- After manually entering `plan` mode (via `updateConfig`/`setMode`, not the
  `EnterPlanMode` tool), `ExitPlanMode` restores the recorded previous mode
  instead of falling back to `build`.
