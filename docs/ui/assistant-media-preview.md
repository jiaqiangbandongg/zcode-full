# Assistant media preview cards

## Status

Implementation specification for the first assistant output media preview release.
This feature is a UI projection of terminal assistant text; it does not add media
rows, snapshot fields, replay events, or Agent metadata. When a card is visible in a
completed turn, the same shared preview-card candidate is eligible for conversation
share preflight. Unsupported video/audio cards remain visible in the UI but are
reported as non-uploadable share warnings.

## Supported formats

Video: `.mp4` (`video/mp4`), `.mov` (`video/quicktime`), `.webm`
(`video/webm`), and `.m4v` (`video/x-m4v`).

Audio: `.mp3` (`audio/mpeg`), `.wav` (`audio/wav`), `.m4a` (`audio/mp4`),
`.ogg` (`audio/ogg`), `.opus` (`audio/opus`), `.flac` (`audio/flac`), and
`.weba` (`audio/webm`).

The card registry, MIME mapping, and file-display icon aliases are the single
source for these extensions. Unsupported containers remain ordinary files and
may be opened with an external application.

## Projection and opening

```text
terminal assistant text (complete/interrupted latest row)
  -> shared file reference extraction
  -> reverse-order, deduplicated candidates (15 max)
  -> workspace-scoped existence check
  -> visible cards (10 max)
       -> conversation-share candidate (same visible set)
  -> PreviewPane media source
       -> local Desktop: authorized zcode-media:// URL
       -> Desktop SSH/WSL/Docker: Host loopback HTTP Range URL
       -> mobile /remote: bounded inline preview when the file is small enough
```

Video uses a native `video[controls][playsinline]` element and audio uses a
native `audio[controls]` element. Neither autoplays. Codec/container decode
failure leaves the card visible and offers the existing external-open action.

Media candidates do not use the Markdown/HTML `fileChanges` gate. Relative
references still undergo lexical workspace containment checks and all file I/O
continues through the selected workspace Host.

## Data-plane boundary

Desktop local playback uses the existing canonical-path authorization registry
and `zcode-media://` file protocol. Main only authorizes exact real paths and
maps the privileged protocol; it does not own media or conversation state.

Desktop remote workspace media does not use a server upload or object-storage
data plane. The Window Host exposes a loopback URL with an opaque lease token and
maps browser Range requests to the selected SSH/WSL/Docker file service's
`readFileRange()` calls. The Host never copies the complete file or puts media
bytes into relay/Main or conversation replay state. Mobile `/remote` remains
inline-only; larger media fails closed and keeps the external-open action.

## Limits and lifecycle

The inline mobile preview limit is 8 MiB. Desktop remote Range previews allow
files up to 512 MiB, with a 1 MiB maximum chunk, four active Host requests, a
10-minute idle lease timeout and a 2-hour absolute lease TTL. Opening a card
starts preparation lazily; card rendering alone does not read or transfer media
files. The kill switch `ZCODE_REMOTE_MEDIA_RANGE_PREVIEW_ENABLED=0` disables
the Desktop remote Range service and falls back to the existing inline limit.

The media service state is `validating`, `local`, `host-range`, `inline`, or
`failed`. A file stat is performed before creating a lease and at the start and
end of each Range request; chunks are not preceded by extra stat RPCs. Client
disconnect, proxy disposal and backpressure cancellation all release per-lease
and Host-global request slots. A changed or expired lease fails closed. The
player keeps the card and external-open action when native decoding, Range
forwarding or inline preview is unavailable.

Local `zcode-media://` authorization is limited to 256 canonical paths with a
30-minute TTL. The synchronous protocol callback revalidates the current
realpath and regular-file type before handing a path to Electron's native file
loader, and the registry is cleared during app shutdown.

## Compatibility invariants

- Desktop remains `desktop-continuous`; mobile `/remote` remains
  `web-remote-replayable`.
- Mobile attaches only to an existing shared Host and never creates a new
  runtime or remote workspace connection.
- Remote routing and caches use `workspaceIdentity?.trim() || workspacePath`;
  `workspacePath` remains the execution/display path.
- Existing image, Office, PDF, Markdown, HTML, and sent-attachment media paths
  keep their current behavior.

## Verification

Unit tests cover extension/MIME extraction, citation compatibility, icon aliases,
card limits, media source routing, loading/error states, Host path authorization,
inline size limits, and file-change invalidation. Runtime coverage includes local
Desktop Range playback. SSH/WSL/Docker Host Range playback is currently covered
by focused/unit tests; the real remote E2E remains APC13 planned. Mobile
large-media playback remains unsupported and does not receive the Desktop
loopback URL.
