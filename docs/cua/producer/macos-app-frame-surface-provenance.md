# macOS App Frame Surface Provenance

Status: implementation contract (2026-08-23)

## Problem

An application capture can contain more than the requested root window. AppKit sheets,
open/save panels, and popovers can own pixels inside the returned raster while carrying a
different `CGWindowID`; an open/save panel can also be hosted by an XPC process. Before this
contract, an app frame stored only the root `(pid, window_id)`. Raw coordinate input therefore
posted every pixel to the root with `SLEventPostToPid`. The OS was not allowed to hit-test the
pixel, so a correctly visible panel could silently receive no event while the tool reported a
successful dispatch.

The regression is captured by `test/fixtures/file-panel-surface-trajectories.json`. The fixture
contains only window identities, bounds, action classes, and outcomes; prompts, file names,
account data, and image bytes were removed from the supplied trajectories.

## Trust boundary

Surface membership is evidence, not a geometry heuristic. A surface belongs to an app frame
only when all of the following are true:

1. macOS Accessibility reaches it from the logical application's focused, main, or top-level
   window through a bounded relationship walk;
2. `_AXUIElementGetWindow` returns a real `CGWindowID`;
3. WindowServer reports the same window before and after capture with stable owner PID, bundle,
   layer, and bounds; and
4. the screenshot geometry and display topology remain stable.

The relationship walk is bounded to 8 levels and 64 nodes. Titles and overlapping bounds are
never used to infer membership. A cross-process surface is allowed only when the AX walk proves
the relationship; dispatch uses its WindowServer owner, while observation retains the logical
application identity.

```text
logical application pid
        |
        +-- AX focused/main/windows seeds
        |          |
        |          `-- AX child surface relationship (<= 8 levels / 64 nodes)
        |                         |
        |                         `-- actual CGWindowID + AX owner pid
        |
        +-- WindowServer snapshot before image
        +-- capture pixels
        `-- WindowServer snapshot after image
                         |
                         v
            stable AppFrameSurfaceSet
```

An app frame records an ordered, front-to-back `capture_surfaces` set. Each entry contains:

- `actual_window_id` and `presentation_window_id`;
- neutral `surface_kind` and AX-proven `relation`;
- real dispatch owner PID and canonical bundle ID;
- capture-time bounds and WindowServer layer.

If the capture contains only the ordinary presentation root and the additive WindowServer
surface ABI is unavailable, no surface record is issued; the root frame keeps the existing live
root-window verification path. This compatibility case must not make the whole observation fail.
If AX has already proved an attached surface but its WindowServer identity is unavailable or
changes during capture, the observation is still returned but its raster is non-actionable with
`capture_surfaces_unavailable` or `capture_surfaces_changed`. Thus the accessibility tree remains
usable while panel pixels remain fail-closed. Malformed or over-limit surface sets follow the same
non-actionable path.

## Observe, act, and lifecycle

```text
capture(before surfaces)
        |
        +-- image + AX tree
        |
capture(after surfaces)
        |
        +-- changed ----------------------------> return tree + non-actionable raster
        |
        `-- stable -> issue frame_id
                         |
coordinate pixel --------+
        |
front-to-back hit inside capture_surfaces
        |
        +-- no proven surface -----------------> action_sent=false
        |
live WindowServer identity check
        |
        +-- closed/replaced/moved/owner changed -> surface_replaced, action_sent=false
        |
        `-- exact match
                |
                +-- presentation app already frontmost AND ordinary OS hit-test
                |   also resolves to this exact surface -> foreground CGEvent
                |
                `-- otherwise -> post to actual owner pid + actual window id
```

An unrelated covering window is not part of an app frame and therefore cannot steal its
coordinate authority. It also prevents the foreground path from being selected: the event stays
window-scoped, so the unrelated window cannot receive it. The foreground split is required because
AppKit can acknowledge a SkyLight window-targeted event without delivering an `NSEvent` to the
sheet responder. Full-display frames keep their separate, ordinary WindowServer hit-test contract.

An observation without a delivered actionable raster suspends implicit coordinate authority.
The latest retained frame remains usable only when the caller explicitly supplies its
`frame_id`; an unqualified coordinate fails with guidance to use an element target or request a
new screenshot. This prevents global AX bounds from being interpreted as pixels in an older
image.

Keyboard calls with only a logical PID resolve the currently focused attached surface. When the
logical application is already frontmost, the broker uses the foreground event chain so AppKit
routes shortcuts and text to that focused surface; it never activates the application implicitly.
When it is not frontmost, input remains scoped to the resolved actual owner and window. An
explicit stale `window_id` never heals to a new generation or to the presentation root; it fails
with `surface_replaced` and requires a new observation. Element re-resolution includes actual
surface identity for the same reason.

### Confirmed foreground recovery for file panels

Some AppKit commands and Chromium file inputs acknowledge PID/window-targeted events without
executing the responder command while the logical application is in the background. The only
product recovery path is the explicit activation action:

```text
open_application(app={pid,bundle_id,window_id}, activate=true)
```

On macOS this exception is accepted only when the fresh `window_id` resolves to a stable
`open_panel`, `save_panel`, or an `attached_dialog` whose AX lineage contains an open/save panel
under the same presentation root. The Helper activates the logical application and focuses that
exact AX-proven surface, then rechecks the actual/presentation identities before reporting
`active=true`. Ordinary windows, popovers, missing lineage, and replaced generations remain
background-only or fail closed. The previously frontmost application is not restored.

`key` and `type` with `strategy=event` never activate implicitly. They require the confirmed
foreground recovery above, a fresh observation, and the exact current `actual_window_id`.
Failure to satisfy that precondition is `foreground_required` with `action_sent=false`, not a
macOS TCC permission error.

## Model-facing state

The existing 14-tool surface remains unchanged. `AppState.window` adds neutral surface fields:

- `surface_kind`: `window`, `attached_dialog`, `open_panel`, `save_panel`, or `popover`;
- `actual_window_id` and `presentation_window_id`;
- `surface_lifecycle`: `stable`, `replaced`, or `closed`.

Elements add `selected` and `default_action`. For open/save panels, the formatted state puts a
short dialog summary before the full element list: selected item(s), default confirmation
control, and its enabled state. Compact output retains these controls and gives one deterministic
path workflow:

```text
Cmd+Shift+G -> observe the attached surface again -> type the full path -> confirm once
```

## Mutation outcome

A dispatch receipt proves only that the event was accepted by the native layer. Mutation
verification is target-specific:

- selection requires `selected=true` or a change in the default confirmation control;
- open/confirm may be proved when the panel closes and control returns to the same presentation
  root;
- a generic accessibility-tree digest change is never sufficient by itself.

Even `return_state="none"` reports the actual dispatch surface, whether retrying the action is
safe, and why an effect is unverified. Post-send uncertainty is never replayed automatically.
These fields are broker-internal surface evidence; the model-facing action result remains
`zcode-cua-action-receipt-v1`. The existing flat permission response remains
unchanged.

The same rule applies to PID-only `type`: it resolves the focused attached surface, records its
dispatch receipt, and enters the mutation barrier before settling state. A capture that briefly
falls back to the presentation root is not proof that the panel closed when the returned tree
still contains a default panel action. This prevents an ordinary sidebar click from being
misreported as a successful confirmation.

## Differential native E2E

The disposable AppKit fixture and M14–M16 task packs exercise the real MCP server, native addon,
WindowServer identities, NSOpenPanel lifecycle, and application-owned oracle. No task uses
`osascript`.

```text
M14 screenshot -> confirmed activation -> exact path -> coordinate Open -> same root -> app oracle
M15 panel gen 1 -> Escape -> root -> panel gen 2 -> old window rejected -> focused sheet input
M16 raster frame -> state-only observe -> naked coordinate rejected
                                      `-> explicit retained frame -> same surface dispatch
M17 background Chrome file panel -> confirmed exact-surface activation -> exact path -> DOM oracle
```

| Case | `main@e0d27a36` before fix | multi-surface implementation |
|---|---|---|
| M14 | panel AX tree was visible, but no actionable panel raster or actual/presentation surface identity was delivered | coordinate dispatched to the actual panel window; panel closed into the same root; fixture oracle selected the exact file |
| M15 | Escape returned `Key pressed 1 time(s).` while the first panel remained open, demonstrating accepted-without-effect feedback | first generation closes, second generation differs, old explicit window returns `surface_replaced`, and PID-only text reports the focused sheet dispatch surface |
| M16 | no actionable panel raster was available, so coordinate authority could not be established | state-only observation rejects the naked coordinate with `action_sent=false`; the explicit retained frame dispatches to the exact captured surface and leaves its generation unchanged |

Run the current implementation:

```bash
node evals/zcode-gui-eval/bin/zge.mjs validate M14
node evals/zcode-gui-eval/bin/zge.mjs validate M15
node evals/zcode-gui-eval/bin/zge.mjs validate M16
```

For a before/after checkout comparison, point `ZCODE_CUA_TS_SERVER_DIST` at the built `dist/cli.js`
for each revision while running the same task definitions. Performance latency is retained as a
non-blocking diagnostic; all behavior, safety, lifecycle, and oracle checks are blocking.

## Cross-platform boundary

- macOS uses the surface set and the verified foreground/background split described above.
- Windows keeps foreground verification plus SendInput/UIA routing. It does not consume macOS AX
  surface relations.
- Linux keeps the single-surface AT-SPI/X11 fallback.

Platform dispatch policies remain separate; the shared frame descriptor carries optional neutral
provenance but does not force the three implementations through one raw input path.
