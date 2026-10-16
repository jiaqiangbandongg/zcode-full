# TUI Input Session Panel

## Goal

The TUI should keep the current model selection visible inside the prompt input
frame and keep the active context budget visible directly below that frame. The
compact composer status surface lets the user inspect the active model,
provider, thought level, and current context length without scanning the sidebar
or transcript.

This row is the compact first step of the broader session metadata surface. It
must stay presentational: it renders state that the TUI already receives and
must not introduce new runtime events, environment variables, storage schema, or
provider behavior.

## Source Of Truth

- `mode` comes from `TuiOptions.initialMode` and later `TuiSubmitPromptResult.mode`.
- `model` comes from `TuiOptions.initialModel`, live `model_request.payload.model`
  when available, and later `TuiSubmitPromptResult.model`.
- `model` is formatted as `<provider>/<model>`. The composer row splits on the
  first `/`, renders the model segment first, and renders the provider segment
  after it in a muted color. A bare model id renders the provider as `-`.
- `thoughtLevel` comes from `TuiOptions.initialThoughtLevel` and later
  `TuiSubmitPromptResult.thoughtLevel`. Bootstrap derives it from the active
  runtime model provider options and model catalog reasoning metadata. When no
  explicit provider options are active, bootstrap falls back to the catalog
  reasoning default level, then the first declared reasoning level. If explicit
  provider options cannot be mapped to a catalog level, it renders as unknown.
- `contextUsed` and `contextWindow` come from the existing TUI session
  projection and live model-complete usage updates. The composer must not
  locally estimate model-visible tokens or introduce a second context counter.
The panel is a TUI projection only. It does not read session storage directly
and does not become a second state owner.

## Layout

Normal layout:

1. Header and separator.
2. Conversation transcript viewport.
3. Input box, including the compact composer status line in its lower-left
   content row.
4. Active status/context row below the input frame.
5. Live status footer.

The compact composer status line is a single terminal row inside the input box:

- Show `<model> <provider> | <thoughtLevel>` from the lower-left edge of the
  input content area.
- Extra vertical space inside the input frame is reserved above this line so the
  metadata stays near the lower border instead of crowding the draft text.
- The provider uses the muted palette so the model remains the primary visual
  signal.
- The thought level uses the warning/accent treatment used for high-signal
  runtime status.
- The line must not wrap, resize the textarea while typing, or overlap the busy
  hint. On narrow terminals, the model/provider text may be truncated before the
  thought level is hidden.
- The busy `esc to interrupt` hint and the context meter are not part of this
  row; they are rendered as the active status/context row described in
  `tui-input-active-status.md`.

During approval, clarification, selection, and workflow panels, the replacement
panel owns the composer slot; this compact row is only part of the normal
composer area.

The footer remains a live execution status area, not the canonical metadata
surface. Token totals and todo items remain visible in the sidebar until the
larger session metadata panel is implemented.

## Rendering

- Missing values render as `-`, not as omitted fields.
- The compact row renders the model selection in this order:
  `<model> <provider> | <thought>`.
- Example: `default-deepseek/deepseek-v4-pro` with thought `max` renders as
  `deepseek-v4-pro default-deepseek | max`.
- The context meter uses compact token units: values below 1,000 render as plain
  integers, thousands render as `K`, and millions render as `M`.
- If `contextUsed` is missing, omit the right-side context meter. If
  `contextWindow` is missing or zero, render only the compact used length.
- The context meter is rendered outside the input frame, on the right side of
  the active status/context row. When a turn is busy it shares the row with the
  left-side spinner and `esc to interrupt`; when idle, the row may render only
  the right-side context meter.
- The row does not render trace, full token usage, cache, or todo data. Those
  remain in the sidebar until a larger session metadata panel is built.

## Tests

- TUI unit tests assert the model ref split helper keeps provider/model parsing
  consistent between the sidebar and composer row.
- TUI unit tests assert the compact line renders model, muted provider, and
  thought level with the expected colors.
- TUI unit tests assert the compact context meter formats current usage and
  percentage, and is rendered as the right-side active status item outside the
  input frame.
- Composer tests assert the status line is passed into the prompt input while
  idle and while a turn is active.
