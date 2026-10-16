# TUI Transcript Message Rows

## Goal

The transcript should make user prompts visually distinct without repeating
speaker labels on every row. In normal NL-to-code sessions the user message is
the main turn boundary, so the row background should carry that distinction
while assistant output stays on the regular transcript surface.

## Scope

- Hide visible `User:` and `Agent:` speaker labels in the TUI transcript.
- Apply a distinct neutral gray background only to user message rows.
- Keep assistant message rows on the normal transcript background.
- Keep assistant markdown rendering, tool parts, thought parts, scrollback, copy,
  and session/runtime message contracts unchanged.
- Do not add a configuration flag or environment variable.

## Rendering Contract

- User rows use `palette.userMessageBackground`, a neutral gray that contrasts
  with the transcript background without using status colors.
- User rows use one terminal row of top and bottom padding so the prompt text
  does not touch the highlighted block edge.
- Agent rows use `palette.background`.
- User plain text uses the default transcript foreground.
- System plain text remains warning-colored plain text.
- Agent text continues to flow through `MarkdownText`.
- The row background is a TUI-only projection detail. It must not change
  persisted session messages, ZCode app-server projection, model-visible history, or
  transcript export data.

## Tests

- TUI rendering tests assert that user rows use the dedicated background.
- TUI rendering tests assert that user rows include vertical padding.
- TUI rendering tests assert that agent rows keep the normal background.
- TUI rendering tests assert that visible transcript text no longer includes
  `User:` or `Agent:` labels.
