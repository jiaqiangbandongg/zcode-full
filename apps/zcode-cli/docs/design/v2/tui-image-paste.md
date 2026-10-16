# TUI Image Paste

## Goal

The TUI should let users paste an image from the system clipboard while the
normal prompt input is focused. The prompt text shows a stable placeholder such
as `[image #1]`, and submitting the prompt sends both the visible text and the
corresponding image attachment through the existing prompt attachment path.

This is a TUI entry feature, not a new provider feature. Bootstrap already
accepts `UserPromptInput { text, attachments }`, and runtime already resolves
inline and local image attachments into model image content blocks.

## UX Shape

The image paste UX, without a full keybinding system:

- Use `ctrl+v` for image paste on macOS/Linux and `alt+v` on Windows because
  Windows terminals commonly reserve `ctrl+v` for text paste.
- Read clipboard images with platform-specific commands or a native macOS fast
  path, normalize clipboard BMP to PNG, and return base64 plus MIME metadata.
- Prompt components keep pasted images as draft state and insert visible image
  labels, then submit the image data alongside the text.
- A path-paste fallback treats pasted image file paths as local image
  attachments.

ZCode keeps these UX ideas but routes external I/O through ZCode's own
adapter boundary.

## Implementation State

Status as of 2026-05-08: the P0 TUI image paste path is implemented and covered
by unit tests.

Implemented behavior:

- TUI input remains a controlled `ink-text-input` value owned by
  `TuiScreen.input`; image draft state is stored separately on `TuiScreen` as
  `draftAttachments` plus `nextDraftAttachmentId`.
- `TuiSubmitPrompt` and `TuiSendInput` now accept `string | { text,
  attachments }`; `TuiPromptAttachment` supports `file`, `image`, and `url`.
- `TuiController.handleInput()` handles image paste before text submission,
  rejects paste while a turn is active, serializes one in-flight clipboard read,
  and keeps existing input shortcuts such as `ctrl+c`, `ctrl+u`, history,
  scrolling, and submit.
- `ctrl+v` appends `[image #N]`, stores a data URL-backed draft image, and
  reconciles attachments when placeholders are edited out, `ctrl+u`/`ctrl+c`
  clears the input, history is recalled, or the prompt is submitted.
- CLI command center parses slash commands from `text`, passes attachments
  through for normal prompts, and rejects slash commands with attachments using
  `Image attachments are only supported for normal prompts.`
- The CLI TUI setup wires `readClipboardImage` to
  `packages/cli/src/clipboard-image.ts`, which reads clipboard images with
  platform-specific commands and returns `data:<mime>;base64,...` without
  calling those commands from TUI code.
- Runtime attachment support is live: bootstrap passes prompt attachments,
  `runtime.executeTurn(input, attachments)` resolves inline and local images to
  model image content blocks, resizes through `ImageProcessorPort` when present,
  persists file parts, and hydration restores persisted image file parts as
  structured user content blocks.

Current limitations:

- Active-turn steering remains text-only. If draft image attachments exist while
  a turn is active, TUI shows an idle-only status and does not call `sendInput`.
- Draft attachment binding still uses exact placeholder retention rather than
  byte ranges or text elements. The placeholder is only a UI reference; the
  actual image mapping lives in draft attachment state before submit, in
  `input_history.attachments` for prompt recall, and in persisted session
  `file` parts after submit.
- Clipboard I/O currently lives in the CLI composition layer. This keeps TUI
  pure, but a future adapter split may move the platform reader under
  `@zcode/adapters` without changing the `TuiReadClipboardImage` contract.
- The clipboard reader snapshots inline data URLs only; it does not persist
  large clipboard media into an attachment artifact store yet.

## UX Contract

- When the normal TUI input is focused and idle, `ctrl+v` attempts to read a
  clipboard image. On Windows, support an additional `alt+v`/meta fallback if
  the terminal does not deliver `ctrl+v` to the process.
- If the clipboard has an image, append a placeholder to the prompt text:
  `[image #1]`, `[image #2]`, etc. Add a separating space when needed.
- The placeholder is user-editable text. If a placeholder is removed from the
  draft, the corresponding draft attachment is removed before submit.
- `ctrl+u` and draft-clearing `ctrl+c` clear both text and draft attachments.
- Restoring previous input history restores text only and clears draft
  attachments for legacy text-only entries. New history entries restore both
  the visible text and recorded attachments, so `[image #1]` is never treated
  as an image unless a matching attachment record exists.
- Submitting an idle prompt with draft images sends:

```ts
{
  text: "describe this [image #1]",
  attachments: [
    {
      type: "image",
      path: "[image #1]",
      content: "data:image/png;base64,..."
    }
  ]
}
```

- If the user submits only image placeholders with no other text, the prompt is
  still valid because the attachment is the user input.
- If a turn is already active, image paste should be rejected with a visible
  status such as `Image paste is available when the prompt is idle.` This keeps
  the existing text-only steering contract.
- Slash commands with draft images should not silently drop images. First
  implementation should reject them with a local response such as
  `Image attachments are only supported for normal prompts.`

## Draft State

Add TUI-only draft attachment state:

```ts
type TuiDraftAttachment = {
  id: number;
  type: "image";
  placeholder: string;
  dataUrl: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  sizeBytes?: number;
};
```

`TuiScreen` owns `draftAttachments: TuiDraftAttachment[]` and
`nextDraftAttachmentId: number`. The TUI should not persist draft attachments
outside the active process; submitted attachments are persisted by runtime.

`TuiController.setInput(value)` reconciles draft attachments by retaining only
attachments whose exact placeholder remains in `value`. This is a pragmatic
first step while `ink-text-input` does not expose cursor ranges. A later custom
input editor can replace this with byte ranges or text elements.

## History and Storage Mapping

`[image #N]` is not a storage path and is not sufficient to recover the image.
It is a stable UI placeholder that must have an adjacent attachment record.

ZCode keeps the mapping at three levels:

- Draft input: TUI owns `draftAttachments[]`, keyed by exact `placeholder`.
- Prompt recall: `InputHistoryEntry.attachments` stores attachment references
  as JSON. Image bytes must not be stored in SQLite; `content` is a
  `zcode-artifact://...` reference when a pasted image needs to be recoverable.
- Session transcript: runtime resolves submitted attachments and persists them
  as `file` parts whose `url` is an artifact reference for image resources.
  Resume and rewind hydrate image-capable `file` parts by reading the artifact
  back into provider-visible image content blocks.

History recall must restore attachments only when the recalled entry contains
`attachments`. A naked string like `[image #1]` from old history remains plain
text and should not be silently mapped to an arbitrary image.

Clipboard images are written through the artifact store under the session's
artifact directory. SQLite may contain the placeholder, MIME metadata, and
artifact URI, but not the base64 image payload. If artifact persistence is
unavailable, history stores metadata only rather than falling back to inline
image bytes.

## Clipboard Boundary

Do not call `child_process`, `fs`, `process.env`, or platform clipboard commands
from TUI components or controller code. TUI only depends on this injected
adapter-facing option:

```ts
type TuiReadClipboardImage = (options: {
  abortSignal?: AbortSignal;
}) => Promise<TuiClipboardImage | null>;

type TuiClipboardImage = {
  dataUrl: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  sizeBytes?: number;
};
```

The CLI composition layer supplies this function. The current implementation is
`packages/cli/src/clipboard-image.ts`; it is allowed to use Node platform I/O
because it sits outside the TUI boundary and exposes only `TuiReadClipboardImage`
to the controller. If this reader grows beyond CLI composition, move it into
`@zcode/adapters` as `clipboard` or as a small platform adapter backed by the
existing execution/file-system boundaries.
Clipboard readers may return the captured image data URL as-is; runtime
attachment resolution is responsible for resizing provider-bound images so their
longest edge is at most 2000 pixels.

Platform plan:

- macOS: use `osascript` to write `PNGf` clipboard data to a temp file, then
  read it as base64 through the file-system adapter.
- Linux: detect `wl-paste` or `xclip`; stream image MIME output into a temp
  file without shell-specific path interpolation where possible.
- Windows: use PowerShell `Get-Clipboard -Format Image` to save PNG to a temp
  file. Keep `alt+v`/meta fallback because many Windows terminals consume
  `ctrl+v`.
- Always use `node:os.tmpdir()`, `node:path`, and per-call temp filenames.
- Clean up temp files best-effort.
- Return `null` when the clipboard has no image or platform tooling is missing;
  do not throw into the TUI for normal absence.

No new `ZCODE_*` environment variable is needed for this feature.

## Observability

Clipboard image failures are hard to diagnose from the TUI status alone because
the visible placeholder, persisted session part, and provider-visible model
request are different representations. Runtime must emit safe structured logs
when a turn contains attachments, without writing base64 image payloads or full
image bytes to logs.

Required runtime logs:

- `turn.attachments.resolved`: emitted after `resolveTurnAttachments`. Include
  `attachmentCount`, image/file/resource counts, each attachment's
  `contentBlockType`, MIME, storage kind, recoverability, error code,
  placeholder/source kind, safe size metadata, artifact presence, and payload
  byte length. Do not include `dataUrl`, artifact contents, hashes, or raw user
  file contents.
- `model.request.media_summary`: emitted before the model adapter sees a
  request when media blocks are present before or after media-budget projection.
  Include incoming/provider-visible media counts, omitted media count, projected
  byte totals, and per-block metadata such as role, message index, block index,
  block type, media type, source kind, placeholder, and data URL byte length.
  Do not include raw base64 payloads.

These logs are debug-level developer observability. They complement persisted
SQLite `file` parts and allow reproductions to answer whether the image was:

- never read from the clipboard,
- resolved only as metadata/text fallback,
- converted to a runtime `image` content block but stripped by media budget, or
- sent as an image block to a provider/model that still cannot understand it.

## Implementation Plan

P0 status:

- Steps 1-9 are implemented for clipboard image paste and CLI prompt
  attachments.
- Step 10 stayed true: runtime/provider behavior reused existing attachment
  support, with additional tests for local image resolution, resize, persistence,
  and hydration.
- Remaining post-P0 work is artifact-backed large media, byte-range placeholder
  binding, non-image attachment UX, and model-capability-aware client warnings.

1. Extend `@zcode/tui` types so prompt handlers accept
   `string | { text: string; attachments?: TurnAttachment[] }`.
2. Add `readClipboardImage?: TuiReadClipboardImage` to `TuiOptions`.
3. Add `draftAttachments` and `nextDraftAttachmentId` to `TuiScreen`.
4. In `TuiController.handleInput()`, handle `ctrl+v` in normal idle input by
   calling `readClipboardImage`.
5. Append a stable placeholder to `screen.input`, store the draft attachment,
   and render a concise status message.
6. Reconcile attachments on input changes, `ctrl+u`, history restore, and
   submit.
7. Submit normal prompts with attachments as `UserPromptInput`; submit text-only
   prompts as strings to preserve existing behavior.
8. Update the CLI command center to accept prompt input objects. It should parse
   slash commands from `text`, reject attachments for local slash commands, and
   pass attachments through only for normal prompts.
9. Add a Node clipboard image adapter in the adapter layer and wire it from the
   CLI TUI setup.
10. Keep runtime/provider code unchanged for the first pass unless tests expose
    a missing MIME or placeholder edge case.

## Tests

Implemented coverage:

- TUI unit coverage in `packages/tui/tests/tui.unit.test.ts` covers successful
  paste/submit, placeholder deletion reconciliation, `ctrl+u` cleanup, no-image
  clipboard status, and busy-turn rejection.
- TUI image-paste regression coverage verifies `ctrl+v` clipboard image paste
  is submitted as `{ text, attachments }` and prompt history restore preserves
  attachment mappings.
- Command-center coverage in `packages/cli/tests/cli.unit.test.ts` covers normal
  attachment pass-through and slash-command attachment rejection.
- CLI prompt coverage in `packages/cli/tests/cli.unit.test.ts` covers `--attach`
  path forwarding into the app API.
- Runtime coverage in `packages/core/tests/runtime-persistence.test.ts` covers
  local image attachment resolution, resize through `ImageProcessorPort`, model
  image content blocks, persisted file parts, and hydration of persisted image
  file parts.

Still needed:

- Adapter unit: macOS/Linux/Windows command construction uses cross-platform
  temp paths and handles missing clipboard tooling as `null`.
- Model-capability tests: image-capable models receive image blocks, while
  text-only models get a stable user-visible fallback instead of raw media.
- Artifact-store tests once clipboard images and large attachments stop living
  only as inline data URLs.

Before merging implementation, run:

```text
npm run lint
npm test
```
