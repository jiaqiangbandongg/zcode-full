# TUI Copy Registry

> Superseded by the typed locale catalog described in
> `docs/design/v2/i18n.md`. This file remains the historical TUI copy boundary
> and still defines which TUI strings are presentation copy.

## Goal

The TUI should keep user-facing strings in a small copy registry instead of
spreading literal copy across controller, renderer, and event formatting code.
NL-to-code work changes quickly, so prompts, status messages, and transcript
labels need one obvious place to review for consistency.

## Boundary

- The registry owns user-visible English copy, labels, help text, and short
  transcript/status templates.
- Protocol values stay where they are used. This includes event type strings,
  schema field names, model payload kinds, tool decision enum values, ANSI
  escape sequences, MIME prefixes, and keyboard control characters.
- Dynamic copy should be exposed as functions that accept already-sanitized or
  bounded values. Truncation and redaction remain in the formatter that knows
  terminal width and safety rules.
- The registry is presentation-only. It does not add storage, environment
  variables, configuration, or runtime I/O.

## Contract

`@zcode/i18n` exports typed locale catalogs. TUI modules receive a resolved copy
object from the TUI entry boundary for stable user-facing labels, help text,
status messages, and fallback text instead of adding new presentation strings
inline.

The object is grouped by UI surface:

- `approval`: permission prompt labels, decisions, and help text.
- `brand`: header and prompt chrome labels.
- `error`: rendered error and cause-chain labels.
- `fallback`: safe fallback labels for missing event payload fields.
- `network`: network panel labels and status words.
- `permission`: permission decision reasons and validation failure text.
- `placeholder`: short placeholders shared across formatters.
- `preview`: bounded preview labels and redaction placeholders.
- `question`: AskUserQuestion labels, review text, and option markers.
- `role`: transcript speaker labels.
- `selection`: generic selection-list labels and help text.
- `session`: session panel labels for model, mode, trace, token, cache, and todo state.
- `slashCommand`: slash suggestion row prefixes.
- `status`: one-line status bar messages.
- `terminal`: terminal capability errors.
- `todo`: todo status markers.
- `toolDetail`: tool input detail labels.
- `transcript`: live transcript lines and short generated agent messages.

Protocol enum strings and schema keys may still appear next to parsing logic, for
example event types, tool names, status enum values, and payload field names.
Boolean or unit display tokens such as `true` and `ms` may remain local when they
are tied to value formatting rather than reusable UI copy.

## Current Implementation Check (2026-05-08)

The implemented registry currently contains the surfaces listed above and is
used by the TUI controller, event formatter, diff display, layout components,
and low-level format helpers. The current implementation also keeps sensitive
generic tool input previews behind `TUI_COPY.preview.redacted` and uses fallback
copy for missing tool names, checkpoint ids, background task ids, model/provider
ids, compact text, and unknown values.

This spec intentionally documents the implemented registry surface rather than
requiring every protocol literal to move into the registry. New user-visible TUI
copy should still be added to `TUI_COPY` first unless the string is a protocol
value, schema key, terminal control token, measurement unit, or locally bounded
debug value.

## Failure Behavior

Missing or malformed event payloads still use safe fallback labels from the
registry, for example `tool`, `background`, `checkpoint`, and `unknown`.
Formatting functions continue to skip invalid fields and preserve existing
truncation/redaction behavior.

## Tests

- Unit tests assert representative copy values through `TUI_COPY` so future
  copy changes have one import path.
- Existing TUI rendering tests continue to cover transcript/status behavior,
  approval prompts, AskUserQuestion, tool details, network status, and
  background terminal lines.
