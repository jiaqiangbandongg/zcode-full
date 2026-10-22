# CUA 14-tool E2E validity contract

Status: normative regression contract

## Goal

`run-cua --all` and `run-cua --common-apps` must prove observable behavior, not merely that an
MCP request returned without an error. The frozen 14-tool manifest remains the protocol source of
truth, while C18 proves that every tool can execute in one controlled session.

## Unfreeze

The frozen 30-tool manifest was **deliberately** reduced to 14. This is a designed contraction, not
accidental drift, and it is recorded here so a future reader does not treat the smaller baseline as
a regression. The rationale, the per-tool judgement and the explicit unfreeze decision live in
`docs/refactor-port-specs/2026-09-10-cua-sdk-v3-api.md` §3 and §4.3.

The new baseline is **14**. The 4-way drift gate (`TOOL_NAMES` + `TIER_TABLE` + `TOOL_REGISTRY` +
the cross-repo evaluator manifest) is **retained**, now asserted at 14 instead of 30. The gate
exists to prevent unintended drift, not to forbid an intentional deletion recorded in this section.

The 17 removed names and their replacement path:

| Removed tool | Replacement path |
|---|---|
| `double_click` | `left_click` with `click_count` 2 |
| `triple_click` | `left_click` with `click_count` 3 |
| `right_click` | `left_click` with `mouse_button` `"right"` |
| `middle_click` | `left_click` with `mouse_button` `"middle"` |
| `hold_key` | `key` with a hold duration |
| `screenshot` (full desktop) | `get_app_state` with `include_screenshot` (per-app raster only) |
| `zoom` | none — per-app raster is delivered at usable scale |
| `list_displays` | none — per-app capture follows the window's display |
| `switch_display` | none — same |
| `cursor_position` | none — pure diagnostic |
| `wait` | none — the SDK settles internally; never sleep |
| `mouse_move` | none — accepted capability loss |
| `left_mouse_down` | `left_click_drag` for drags; press-and-hold is an accepted loss |
| `left_mouse_up` | same |
| `read_clipboard` | none — accepted capability loss |
| `write_clipboard` | the native `paste` tool, one of the frozen 14 (Helper-side save → write → platform paste key → restore) |
| `open_application` | `get_app_state` with an `app_ref` — an app that is not running is cold-launched **in the background** inside the observation path. The three sub-capabilities have no replacement: `activate` (foreground it), `url` (launch with a document) and `new_instance` (a second same-bundle process) are all gone. Harnesses that need a document or folder already open must arrange it as fixture setup before the tool surface is used. |

The count is 30 − 17 removals + 1 new tool (`paste`) = 14. Any row added or dropped here must keep
that arithmetic true against the frozen manifest, otherwise the table is no longer a contract.

There is no full-desktop raster in the 14-tool surface. Anything that previously reasoned over the
whole screen must now name an app and read its per-app capture.

## Evidence boundary

Every mutating tool needs an oracle outside the tool result:

- pointer actions require a trusted DOM/native event with the expected button, event family and
  target region;
- keyboard and semantic actions require a resulting DOM/AX state change;
- macOS native keyboard workflows that depend on the active responder chain use
  explicit `strategy=event` with an exact verified `window_id`, then require a
  filesystem/RTF oracle; a returned “Key pressed” string is never sufficient;
- per-app raster requires deterministic raster content plus an actionable `image_ref`; the
  evaluator reads the adjacent `image_ref.frame_id` only as internal lineage evidence, while the
  model-facing action path submits coordinates without relaying that token;
- lifecycle tools require ordering (`request_access` first, `stop_computer_control` last) and the
  runtime effect appropriate to the tool.

An evaluator must fail when a required behavior oracle is missing even if the tool returned
`isError=false`. Diagnostic screenshots are retained after the oracle settles. An optional bounded
hold may make manual observation easier, but the hold is never the pass condition.

Agent traces retain the exact model-facing MCP text, which may omit `structuredContent` and truncate
large payloads. A native AX oracle may parse a text AppState only from a successful official CUA
tool result and only when `state_id`, the expected bundle id, `window_id`, and an element section are
all present. Model final prose is never evidence. For large `list_windows` results, identity changes
use the ingestion-time `windowIds` extracted before model-facing truncation; parsing the shortened
JSON alone can turn a real new window into a false failure.

## Fresh authority

Element `state_id` and the transport's current pixel frame are single-authority snapshots. After an
action that may mutate the app, the evaluator must explicitly re-observe before the next element
action; the tool no longer performs that `get_app_state` call implicitly by default. An explicit
`return_state="compact"` remains available for a one-off post-action state. After
a pixel action, it must obtain a new actionable raster before another coordinate action. The
default model lane submits only raster `x/y`; transport binding plus dispatch-time supersession
checks enforce freshness. Deterministic compatibility tests may pass an explicit
`image_ref.frame_id`, and must prove stale or invalid ids fail closed instead of falling back to the
latest frame. Reusing stale visual evidence is a test bug, not a product failure.

## Fixture isolation

Chrome fixture cases bind to the exact launched pid and unique window title. They must not fall back
to another user Chrome process. Foreground readiness uses macOS built-in process/session probes and
must not depend on the removed Python/PyObjC project. Optional PyObjC-based Chrome AX enabling may
run only when an explicit usable Python environment exists; its absence is diagnostic and must not
poison an otherwise valid fixture run.

## Coverage audit

C18 must reach all 14 manifest names before it can pass. Early exit records the exact missing set.
The broader C01-C18 and M01-M13 suites provide independent scenario coverage so C18 is not the only
oracle for a tool family. Reports distinguish `infra_fail`, evaluator-contract failures, and product
behavior failures; none of them may be presented as a successful E2E run.

`FULL_SURFACE_ORACLE_CHECKS` is the mechanically tested one-to-many mapping from each frozen tool
name to its independent checks. It covers inventory and exact fixture identity; per-app raster
signature and frame lineage; trusted pointer event family, button, multiplicity and drag geometry —
including the `click_count` 2 and 3 forms and the right/middle `mouse_button` forms now routed
through `left_click`; exact text/selection/key/action effects, where `key` also covers the
hold-duration form; access readiness; and the stop latch plus rejection of a subsequent action.
`protocol.all_14_tools_have_passing_oracles` fails if any mapping entry is absent or non-passing.

Finder is a deliberate foreground exception. Its AppKit inline-editor responder accepts the
window-scoped background event receipt without performing the rename. M01 and M04 therefore bind an
exact live `window_id`, select the observed item, and send `Return/name/Return` in one
`strategy=event` batch. Only the temporary-directory filesystem state can pass those workflows.

TextEdit character styles are another responder-chain case. M08/M09/M10 focus and re-observe the
editor, select an exact AX text range, then send the style and save shortcuts with the verified
`window_id`, `strategy=event`, and `return_state=none`. The saved RTF control word is the only pass
condition. M05 instead tests append persistence: TextEdit may autosave before a redundant `cmd+s`
can be sent, so its contract ends when the external file oracle is stably true.

Chromium keyboard navigation cannot use the background auto route merely because the broker
accepted it. C16 binds the exact fixture window and requires `strategy=event` for type, Tab, the
held `key` form, and Enter. Passing requires both the submitted DOM value and trusted Shift
keydown/keyup records. A successful `Key pressed` response without those DOM events is a failure.
