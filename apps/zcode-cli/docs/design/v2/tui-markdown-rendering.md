# TUI Markdown Rendering

## Goal

The TUI should render assistant markdown as structured terminal content instead
of showing raw markdown punctuation in a single plain `text` node. Markdown is a
presentation concern: it makes model answers, code fences, lists, quotes, and
links easier to scan without changing session state, model-visible messages, or
runtime event contracts.

This is especially important for NL-to-code work because assistant responses
often contain file paths, fenced code, diffs, checklists, and short design notes.
The first version should be good enough for sustained coding sessions, stream
smoothly, and degrade to plain text when the terminal renderer cannot provide
rich markdown.

## Rendering Shape

Message rendering stays part-based:

- assistant text parts are rendered with OpenTUI `<markdown>` when available;
- otherwise assistant text falls back to `<code filetype="markdown">`, which
  still gives markdown-aware highlighting;
- reasoning text is rendered as subtle markdown-flavored code with
  `streaming={true}`;
- theme tokens include explicit markdown colors for heading, link, inline code,
  block quote, emphasis, strong text, list markers, images, and code blocks;
- code block visibility is treated as TUI-local presentation state, not runtime
  session state.

ZCode does not gate markdown behind an experimental flag. The default is
automatic capability detection:

1. Prefer OpenTUI's native `markdown` renderable when available and stable.
2. Fall back to OpenTUI `code` with `filetype="markdown"`.
3. Fall back to plain `text` if markdown/code renderables fail to initialize.

Implementation note: the first OpenTUI-backed slice temporarily used a small
TUI-local markdown projection because older renderer behavior could expose raw
markers such as `###`, `**`, and inline backticks in normal assistant prose.
OpenTUI 0.2.15 provides a native `MarkdownRenderable` with concealment and
streaming support, so ZCode should prefer the native `<markdown>` renderable and
avoid maintaining a parallel parser in the TUI.

## Scope

- Render assistant final text and live streaming text as markdown.
- Keep user messages, system messages, tool status lines, and bounded tool
  detail blocks plain unless a surface explicitly opts in.
- Add a TUI-local markdown component and theme mapping.
- Preserve copy/select behavior: selected rendered text should copy human text,
  not ANSI escape sequences or internal styling metadata.
- Keep markdown rendering inside `@zcode/tui`; no runtime, provider, tool,
  session store, ZCode app-server, or CLI protocol changes are required for the first slice.

## Non-Goals

- Do not parse or normalize markdown in core runtime.
- Do not add a `ZCODE_` environment variable or feature flag for the first
  version.
- Do not render arbitrary HTML, remote images, inline SVG, or embedded media.
- Do not make terminal links open external programs in the first slice.
- Do not reinterpret tool outputs as markdown by default. Tool result previews
  remain bounded tool-specific projections.
- Do not introduce a large markdown dependency unless OpenTUI's built-in
  renderables cannot satisfy the contract.

## Rendering Contract

`MessageRow` should delegate textual content to a presentation-only component:

```ts
type TuiTextFormat = "plain" | "markdown";
```

The renderer decides format from local projection metadata:

- assistant `message.content`: `markdown`;
- assistant text transcript parts: `markdown`;
- live model text: `markdown` with streaming enabled;
- reasoning text, when surfaced later: `markdown` with subtle theme tokens;
- user/system text: `plain`;
- tool transcript text: existing tool-specific components.

The markdown subset for the first slice:

- paragraphs and hard line breaks;
- headings;
- ordered and unordered lists;
- block quotes;
- emphasis and strong text;
- inline code;
- fenced code blocks with optional language;
- links as styled terminal text;
- horizontal rules when supported by the renderer.

Inline emphasis behavior follows OpenTUI's native markdown parser in this
slice. If identifiers or session ids reveal an underscore-emphasis collision in
practice, handle that as a focused renderer policy change after comparing the
native output in the TUI.

Unsupported markdown constructs should degrade predictably:

- tables render as wrapped plain markdown rows unless OpenTUI handles them well;
- images render as link-like alt text plus URL when available;
- raw HTML is escaped or shown as plain text;
- broken or unfinished fences during streaming remain visible and must not throw.

## Theme Contract

The markdown theme adapter maps the resolved TUI theme from
`tui-theme.md` to OpenTUI syntax/markdown tokens:

- base text: `theme.markdownText`;
- heading/strong: `theme.markdownHeading` and `theme.markdownStrong` with
  bold attributes where supported;
- link/link text: `theme.markdownLink` and `theme.markdownLinkText`;
- inline code/code block: `theme.markdownCode` and
  `theme.markdownCodeBlock`, with `theme.backgroundPanel` only when it does
  not reduce contrast;
- block quote: `theme.markdownBlockQuote`;
- list marker/enumeration: `theme.markdownListItem` and
  `theme.markdownListEnumeration`;
- horizontal rule: `theme.markdownHorizontalRule`.

The adapter must be deterministic and side-effect free. It should not read
terminal state, config files, or environment variables. If the renderer exposes
different token names across OpenTUI versions, the adapter should provide the
smallest compatibility shim in `@zcode/tui`, not spread renderer conditionals
across components.

## Module Plan

Keep the implementation split so the renderer remains easy for agents to pick
up:

- `packages/tui/src/app-markdown.tsx`
  - `MarkdownText` component.
  - Capability-based choice between native `markdown`,
    `code filetype="markdown"`, and plain `text`.
  - Props: `content`, `streaming`, `tone`, `backgroundColor`, `foregroundColor`.
- `packages/tui/src/app-markdown-theme.ts`
  - Theme-to-markdown/syntax style mapping.
  - No external I/O.
- `packages/tui/src/app-components.tsx`
  - `MessageRow` delegates assistant text to `MarkdownText`.
  - Existing `ToolTranscriptPartView` stays unchanged.
- `packages/tui/src/app-model.ts`
  - Optional projection metadata only if needed, for example
    `TextTranscriptPart.format?: TuiTextFormat`.
  - No contract dependency on runtime message types.

If OpenTUI's native markdown renderable requires extra grammar or query assets,
update the SEA asset collection plan before implementation so packaged macOS,
Linux, and Windows binaries keep the same behavior as workspace installs.

## Streaming And Performance

Markdown rendering must preserve the existing long-running-session assumptions
from `ink-tui-renderer.md`:

- live model output updates one visible assistant message rather than appending
  new rows per delta;
- render work is memoized by content identity, width-sensitive renderer state,
  theme, and render mode where possible;
- `streaming={true}` should be passed to OpenTUI markdown/code renderables when
  supported;
- off-screen transcript rows should continue to rely on OpenTUI scrollbox
  viewport culling;
- parser or highlighter failures fall back to plain text for that message
  without breaking the rest of the transcript.

Do not trim content in a way that changes user-visible code fences. It is safe
to drop leading/trailing empty lines around model messages if that matches the
existing transcript style, but fenced code contents must be preserved exactly
inside the fence.

## Interaction Model

P0 has no new keybinding. Markdown is the default assistant presentation.

P1 may add a TUI-local code block visibility toggle:

- state lives in TUI presentation state;
- it applies only to rendered transcript code blocks;
- it must not alter copied source content, session history, or exported
  transcript content;
- if a keybinding is added, it must go through the existing TUI keyboard
  registry and help surfaces.

## Failure Behavior

- If OpenTUI lacks the `markdown` renderable, use `code filetype="markdown"`.
- If syntax highlighting initialization fails, render plain text.
- If an unknown fenced language is encountered, render the code block as plain
  code.
- If a streaming delta leaves markdown temporarily invalid, render the partial
  document instead of suppressing content.
- If a message is extremely large, rendering should remain bounded by viewport
  culling and future code-block folding, not by silently truncating assistant
  text.

Errors from the markdown renderer should be caught only at the presentation
component boundary. The TUI should surface a short status detail in debug paths
if useful, but normal users should see the plain-text fallback.

## Cross-Platform Notes

The feature must work the same on Windows, macOS, and Linux:

- no shell commands;
- no POSIX-only path handling;
- no terminal-specific escape assumptions outside OpenTUI;
- no reliance on executable bits or platform font features;
- no environment-variable feature gate in P0.

If OpenTUI markdown assets differ by native package, the packaging test must
assert that every supported target includes the required files.

## Rollout Phases

### Phase 0: Renderer Capability Spike

- Verify OpenTUI 0.1.97 exposes React host elements for `markdown` and `code`.
- Verify `filetype="markdown"`, `streaming`, and `syntaxStyle` props work in
  the current React bridge.
- Verify whether grammar/query assets need explicit SEA inclusion.
- Record any missing OpenTUI capability in this spec before coding around it.

### Phase 1: Assistant Markdown P0

- Add `MarkdownText` and markdown theme adapter.
- Render assistant final responses and live model text as markdown.
- Keep user/system/tool rows plain.
- Add plain-text fallback.
- Add focused TUI unit tests.

### Phase 2: Part-Aware Rendering

- Add optional `format` metadata to text transcript parts if needed.
- Render assistant text parts as markdown while preserving tool parts as
  structured tool projections.
- Prepare reasoning text rendering as subtle markdown once reasoning parts are
  projected into the TUI.

### Phase 3: Code Block UX

- Add local code-block collapse/expand behavior if long code blocks make the
  transcript noisy.
- Add a help/keyboard entry only after the state model is stable.
- Preserve copy behavior and transcript export semantics.

### Phase 4: Shared Preview Surfaces

- Reuse the same markdown component for `AskUserQuestion` markdown preview and
  other opt-in TUI preview fields.
- Keep HTML preview out of scope unless a separate sandboxed preview spec is
  written.

## Tests

Unit tests should cover:

- assistant message rows use the markdown renderer;
- user and system messages remain plain text;
- live model text passes `streaming=true`;
- fenced code blocks and unfinished fences do not throw;
- unsupported markdown renderer path falls back to plain text;
- theme adapter maps markdown tokens without reading external state;
- selected rendered text remains copyable through the existing OpenTUI
  selection path;
- SEA asset collection includes any renderer assets required by OpenTUI
  markdown/code highlighting.

Manual verification should include:

- a response with headings, lists, inline code, links, and fenced TypeScript;
- a streaming response with an unfinished code fence;
- CJK text mixed with markdown punctuation;
- terminal color disabled or low-color mode if OpenTUI exposes that signal;
- packaged TUI smoke tests on each supported OS target where possible.

## Acceptance Criteria

- Assistant markdown is readable in the TUI without raw syntax dominating the
  transcript.
- Plain-text fallback is reliable and silent for normal users.
- Runtime/session/tool contracts are unchanged.
- No new environment variables are introduced.
- `npm run lint` and `npm test` pass before implementation is considered done.
