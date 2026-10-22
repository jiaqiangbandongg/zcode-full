# CUA Action Receipt and Observation Contract

This spec supersedes the previous model-visible post-action state and
delta/no_change execution contract for the TypeScript CUA tool layer.

## Contract

Mutating tools return an action receipt by default. The default
`return_state` is `none` for pointer, keyboard/text, and semantic actions.

```json
{
  "action_receipt": {
    "schema_version": "zcode-cua-action-receipt-v1",
    "action_sent": true,
    "dispatch_status": "accepted",
    "retry_action": false
  }
}
```

`dispatch_status` is `accepted`, `possibly_sent`, or `not_sent`. `possibly_sent`
means the request may already have reached native dispatch, so the caller must
not replay non-idempotent actions automatically. A stale element that the
Helper proves was not dispatched returns an error receipt with
`action_sent=false`, `dispatch_status="not_sent"`, and no automatic heal.

When `return_state="none"`, the tool returns the action note plus the receipt
and performs no `capture_app` call.

When `return_state="compact"` or `return_state="full"`, the tool performs
exactly one post-action `capture_app` call with:

```json
{
  "include_screenshot": false,
  "force_full": true
}
```

The result is still a full CUA observation. `compact` and `full` only control
how much of that full state is formatted for the model.

If the optional post-action observation fails, the receipt is preserved and the
state is reported as unavailable. The tool must not replay the action.

The receipt content block precedes the accessibility tree whenever an explicit
observation is returned. This ordering is part of the safety contract: a host
that bounds or truncates a long tree must retain `dispatch_status` and
`retry_action=false`.

Target read-back must verify the intended effect of the exact control action.
`AXSelected` is a valid postcondition for selecting a row or toggling a
selection-bearing control, but it is not a generic `AXPress` success signal. In
particular, a menu-bearing button can expose `AXSelected=false` before and after
opening its menu. That unchanged value must not produce
`target_verification_status="mismatched"`; menu visibility needs its own
observable postcondition, otherwise the receipt remains accepted without a
target-verification claim.

## Producer and Helper Version Boundary

Mixed producer/Helper versions are unsupported. Installing a new producer must
install or replace the bundled Helper from that same build. The plugin launcher
pins its default server spec to the plugin version, and production Helper
startup verifies the embedded build id before reuse. A stale Helper is replaced
at install/startup; runtime action classification does not carry compatibility
branches for older Helper wire formats.

## get_app_state

`get_app_state` is always model-visible full state. The tool layer always sends
`force_full=true` to `capture_app`.

Broker-internal `delta` and `no_change` replies are not exposed as executable
model state. They must not publish a reused `state_id`, a partial patch, or a
`repeat_observation` hint.

An empty full accessibility tree is a valid observation. The tool layer does
not perform an empty-tree warmup retry.

## Out of Scope

This contract does not change exact raster delivery, image/image_ref adjacency,
full-display provenance, WindowServer owner checks, overlay behavior, topology
validation, native dispatch guards, or `possibly_sent` delivery safety.

## Release Evidence

The final model-in-the-loop canvas and element-mutation lanes must use the
real-model gate model designated in the eval provider configuration.
Both lanes require fixture-owned postconditions and must reject duplicate native
dispatch; a successful MCP return alone is not release evidence.
