# CUA coordinate internal frame binding

## Problem

The model-facing coordinate contract previously required the model to copy an
opaque `frame_id` from a text block adjacent to the raster:

```json
{"type":"coordinate","frame_id":"frame-ab12cd34","x":38,"y":105}
```

`frame_id` is transport authority, not visual task input. Requiring the model to
relay it leaks CUA bookkeeping into the model contract and makes correct visual
actions depend on copying an opaque implementation token.

## Contract

The public coordinate target is:

```json
{"type":"coordinate","x":38,"y":105}
```

The model copies the integer pixel indices from the exact raster it just
observed. It performs no Retina, DPI, crop, resize, display-origin, or native
pointer conversion.

CUA binds an unqualified coordinate to the newest actionable raster in the
current MCP transport session before any asynchronous work begins:

```text
model-visible raster (1280 x 645)
             │ x/y only
             ▼
bind latest actionable frame in this transport
             │ immutable frame descriptor
             ▼
validate actionable + TTL + app/window ownership
             │
             ▼
project raster pixel center ──► native pointer unit ──► dispatch
```

The bound target carries the opaque frame id internally through queue admission
and dispatch. If a newer actionable observation is issued while the action is
waiting, the old bound target remains valid inside its retained-frame lifetime;
it is never rebound to the newer geometry.

A state-only observation publishes no raster and therefore neither advances nor
revokes the current implicit pixel authority. The newest retained actionable
raster remains the binding source until another actionable raster is published
or its normal TTL/LRU/actionability checks fail. AX `bounds` in a state-only
result remain global screen points and must never be submitted as raster `x/y`;
models that need coordinates must continue using pixels chosen from the retained
raster or request a new raster.

For backward compatibility, callers may still provide `frame_id`. An explicit
identifier is authoritative: unknown, expired, evicted, cross-session, or
non-actionable values fail closed and never fall back to the latest frame. A
previous actionable frame that is still retained and in-TTL remains valid even
after a later observation creates a newer frame.

## Invariants

- No actionable raster in the current transport means coordinate actions fail
  before dispatch.
- The implicit binding is transport-local and cannot select another MCP
  session's frame.
- Binding happens synchronously before app resolution or broker I/O.
- Queue-time revalidation uses the internally bound id, so concurrent
  observations cannot reinterpret existing `x/y` values or reject them solely
  because a newer frame now exists.
- State-only observations update element state but do not mutate implicit pixel
  authority; they cannot force the model to relay an opaque retained `frame_id`.
- `image_ref` remains adjacent to the raster for integrity verification and
  diagnostics, but the model does not need to read or repeat it.
- Every raster observation starts with the canonical adjacent
  `[image, image_ref]` pair. Task state or compact metadata follows it.
- Coordinates selected from the latest per-app raster are submitted unchanged
  and CUA binds that frame internally.
- Model-visible recovery errors never instruct the model to copy
  `image_ref.frame_id`. After expiry, missing retained pixels, non-actionable
  frame status, or live-owner change, they require a fresh observation and new
  raster `x/y`; deterministic compatibility callers may still use an explicit
  retained id.

## Regression evidence

Tests must cover schema/runtime acceptance without `frame_id`, explicit invalid
id refusal, no-frame refusal, latest-frame selection, retained explicit old-frame
dispatch, queued bound-frame dispatch after a later observation, and rejection
of implicit ancestor-space guessing. A provider probe must verify that every
tool-result block is delivered in order, and a model-in-the-loop run must click
from visual `x/y` without relaying the opaque id.
