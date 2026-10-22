# CUA Action Receipt State Simplification

## Contract

Mutating element actions are single-dispatch operations. A stale native element
must return `action_sent=false` and ask the model to observe again; the tool
must not capture a fresh tree, find a similar element by fingerprint, and retry
the action.

When a broker action is accepted or becomes `possibly_sent`, the session only
consumes the `pre_state_id` that supplied the target element. Other cached
states for the same app or window remain usable. There is no app/window-wide
`refresh_required` write lock.

A native element returned by a fresh coordinate hit-test has no `pre_state_id`.
Dispatching it therefore consumes no cached accessibility state; the app scope
is still verified independently before the action RPC.

Pointer `strategy="auto"` is scoped to the current call. It does not remember
or infer a future event fallback from AX tree quality. A fallback from semantic
AXPress to coordinate/event click is allowed only when the broker proves the
semantic capability check did not dispatch (`action_sent=false`).

## Preserved Read-Only Matching

Fingerprint matching remains available for visual same-capture consumers, i.e.
the per-app raster returned by `get_app_state` with `include_screenshot`. That
path matches elements inside an already captured raster and does not issue a
second mutating native action.

## Regression Requirements

- `accepted` and `possibly_sent` consume only the referenced `pre_state_id`.
- stale element action errors perform one native action attempt and zero
  `capture_app` retries.
- same-app/same-window states with different `state_id` values are not locked
  out by a prior action.
- `strategy="auto"` keeps its requested strategy unless the current broker
  response proves a no-dispatch capability fallback.
