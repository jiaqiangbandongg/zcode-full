# TUI Tool Call Detail Blocks

## Goal

The TUI should show enough detail for each live tool call for the user to
understand what is about to run, what is running, and what just finished. A tool
line that only says `Tool Bash running` or `Tool Read completed` is not enough
for NL-to-code work because the user cannot audit commands, file paths, search
patterns, URLs, or subagent tasks without scrolling into hidden debug state.

## Boundary

- Runtime remains the source of truth for tool execution.
- TUI consumes `SessionEvent` only. It must not call tool handlers, read files,
  execute commands, or inspect tool internals.
- The primary detail source is `tool_call_scheduled.payload.input`. The TUI may
  cache a summarized projection by `toolCallId` so later `started`, `result`, and
  `error` events can render the same detail block even when those events do not
  repeat the input.
- The detail block is presentation state only and must not be injected into model
  history or persisted as a new session fact.
- Tool result display payloads are presentation state with durable replay. When
  `tool_call_result.payload.result.display.kind` is `file_diff`, the live TUI may
  render a bounded diff preview after the cached input detail block; when the same
  session is resumed, the TUI reads `part.state.metadata.display` from persisted
  `message + part` data and renders the same preview.
- The display payload must not be reinterpreted as model-visible tool output. It
  is a bounded UI projection shared by live events, ZCode app-server replay, and session resume.
- The first implementation changes persisted tool part metadata but does not
  change tool input schemas, core scheduling, permission behavior, provider
  adapters, or model-visible tool results.

## Rendering Contract

Every visible tool call transcript line may include a concise title plus a
small indented detail block directly below it:

```text
Tool Bash running
  command: npm test
  cwd: packages/tui
```

The tool transcript part itself must not add a global left gutter. The title
starts at the same content column as adjacent assistant text; only nested
details, legacy output, and result display rows use their local semantic
indentation.

The block should be stable across `pending`, `running`, `completed`, and
`failed` lines for the same `toolCallId`. If no input detail is available, the
TUI falls back to the current tool-name-only line.

Tool events should update one visible transcript part per `toolCallId` instead
of appending separate pending/running/completed rows. This follows a
message-part model while keeping ZCode's `SessionEvent` as the only input:

- `tool_call_scheduled` creates or updates a tool part and stores bounded input
  details.
- `tool_call_started` and `tool_call_progress` move the same part to running.
- `tool_call_result` moves the same part to completed and attaches any bounded
  display payload.
- `tool_call_error` moves the same part to failed and shows a redacted,
  user-facing error summary.
- Session resume builds the initial transcript from persisted `message + part`
  data. Completed tool parts with `state.metadata.display.kind = file_diff`
  attach that payload to the restored TUI tool part. Completed legacy parts
  without display metadata continue to show `state.output`.

Errors render directly under the tool title using the TUI error color/style.
The line should contain the human error description itself, not an extra
`error:` label, because the color and placement already express the type.

Known tools should prefer human audit fields and, where useful, replace the
generic lifecycle title with a stable action title:

- `Bash`: `command`, `cwd`, `timeout`, and background mode. If `argv` exists,
  show the executable and arguments as a secondary line.
- `Read`: title is `Read <path>`, where `<path>` is workspace-relative when the
  requested file is inside the current workspace and remains an absolute path
  when it is outside the workspace. Do not prefix the title with `Tool` or append
  lifecycle status text. Include `offset`, `limit`, or `pages` as detail lines
  when present.
- `Write`: `file_path`; include `offset`, `limit`, `pages`, or `replace_all`
  when present.
- `Edit`: title is `Edit <path>`, where `<path>` is workspace-relative when the
  requested file is inside the current workspace and remains an absolute path
  when it is outside the workspace. Do not repeat `file_path` or `replace_all`
  as default detail lines because the path is already in the title and the diff
  is the audit surface.
- `Grep`: `pattern`, `path`, `glob`, `output_mode`, `type`, and limits.
- `Glob`: `pattern` and `path`.
- `WebFetch`: `url` and a prompt preview.
- `TodoWrite`: todo count and current in-progress item when present.
- `Agent`: `description`, `subagent_type`, and background mode.
- `Skill`: skill name.
- MCP and unknown tools: show a bounded generic input preview with sensitive keys
  redacted.

`tool_call_result` may append result display lines after the stable input detail
block. The first supported payload is `file_diff`: render the bounded patch with
OpenTUI `diff` renderable so code syntax highlighting, line-number gutters,
`+`/`-` markers, and red/green full-line backgrounds stay consistent with the
rest of the TUI. Do not render a separate `diff: <path> (+n -n)` title or raw
`@@ ... @@` hunk headers in the compact transcript. On narrow terminals the
preview uses a unified layout with a single line-number column; on wide
terminals it uses a split layout with old and new columns. Fallback plain-text
lines stay bounded and must show a short truncation marker rather than dumping
the full patch.

## Safety And Size Limits

- Never render large content blobs verbatim. Fields such as `content`,
  `old_string`, `new_string`, `prompt`, and nested arrays should be summarized
  or previewed with strict width and line limits.
- Redact common sensitive keys such as `token`, `secret`, `password`, `api_key`,
  and environment variable values. For `Bash.env`, show names being set or unset,
  not values.
- A single detail block should remain small, normally no more than four lines.
  Lines must be truncated using display-cell width, not JavaScript string length.
- The feature does not add any `ZCODE_` environment variables.

## Failure Behavior

Malformed input or an unsupported schema must not break rendering. The TUI should
skip invalid fields and fall back to a bounded generic preview. If the preview
cannot be produced safely, omit the block.

If result/error events arrive without a prior scheduled event, the TUI should
append a minimal fallback tool part using the cached tool name or `tool`. Missing
input details are acceptable; missing transcript rendering is not.

## Tests

- TUI unit tests cover `Bash` detail blocks including command and cwd.
- TUI unit tests cover tool rows without an extra global left gutter.
- TUI unit tests cover `Read` titles including workspace-relative and
  workspace-external file paths, plus range detail lines.
- TUI unit tests cover `Edit` titles including workspace-relative and
  workspace-external file paths, plus omission of duplicated input and hunk
  metadata rows.
- TUI unit tests cover reuse of scheduled input details on later result events.
- TUI unit tests cover generic unknown-tool previews with sensitive-key
  redaction and the four-line detail limit.
- TUI unit tests cover `file_diff` result display payloads, including path,
  fallback hunk lines, renderer props, and red/green background colors.
- TUI unit tests cover narrow unified and wide split diff renderer selection.
- Resume tests cover persisted `file_diff` metadata and old completed tool parts
  that only have `output`.
