# CUA E2E case catalog

## Scope and evidence levels

This catalog is the product-level index for Computer Use. It maps product cases
to the producer (`zcode-cua`) and consumer (`z-code`) evidence that proves them.
Passing one platform never implies another platform passed.

Evidence levels:

- `desktop-e2e`: ZCode Electron UI/runtime path.
- `mcp-e2e`: real MCP transport plus deterministic broker/native oracle.
- `live-macos`, `live-windows`, `live-linux`: real OS application and independent
  post-condition oracle.
- `contract`: deterministic unit/integration safety gate. It supports but does
  not replace a required live platform lane.

The coordinate authority boundary is:

```text
model-visible raster -> integer x/y only
                    -> CUA transport binds immutable current frame
                    -> crop/Retina/DPI/display projection
                    -> native provenance gate
                    -> OS input dispatch
```

## Product cases

| ID    |   P | Product assertion                                                                                                                                                  | Automated owner/evidence                                                                       | Required lane                                 |
| ----- | --: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------- |
| CU-01 |  P0 | Local macOS/Windows Composer shows entry; SSH/WSL/Docker/Web/mobile do not                                                                                         | `packages/ui/test/cuaComposerEntryState.test.ts`, `useCuaComposerEntry.test.ts`; desktop smoke | desktop-e2e macOS + Windows                   |
| CU-02 |  P1 | Disabled/starting/permission/ready/error colors and clickability are exact                                                                                         | `cuaComposerEntryState.test.ts`, `v4ComposerCuaEntry.test.ts`                                  | desktop-e2e                                   |
| CU-03 |  P0 | Missing Accessibility/Screen Recording causes zero input and an accurate ordinary tool error; the model may inspect it with read-only `request_access`             | producer permission-error passthrough, C14 degradation, M11                                    | mcp-e2e + live-macos                          |
| CU-04 |  P0 | No CUA tool error automatically opens permission onboarding; foreground/UIPI/Linux failures keep their original recovery guidance                                  | producer stdio error matrix + consumer no-gate unit/replay                                     | consumer integration + live platforms         |
| CU-05 |  P0 | Granting permission converges after one Helper restart/verification                                                                                                | permission status store + restart/verify contracts                                             | live-macos signed/dev Helper                  |
| CU-06 |  P1 | Concurrent Composer is busy and recovers after task                                                                                                                | composer busy contracts                                                                        | desktop-e2e multi-window                      |
| CU-07 |  P1 | Hidden entry persists and does not stop an active task                                                                                                             | composer visibility/storage contracts                                                          | desktop-e2e restart + active turn             |
| CU-08 |  P1 | `open_application` defaults to background launch                                                                                                                   | producer launch/focus contracts; native M11/M12                                                | live-macos/windows                            |
| CU-09 |  P0 | Focus steal requires `activate=true` and confirmation                                                                                                              | producer open-application schema/handler tests                                                 | live-macos/windows                            |
| CU-10 |  P1 | Same-app windows remain distinguishable by PID/title/window id                                                                                                     | ZGE C13, M13                                                                                   | live-macos/windows                            |
| CU-11 |  P1 | Text editor state exposes accurate actionable/editable/selected/disabled elements                                                                                  | ZGE M03/M05/M13; act-verify AV03/04                                                            | live-macos                                    |
| CU-12 |  P1 | Screenshot is complete, oriented, scaled, non-black, and renderable                                                                                                | ZGE C07/C14; exact-raster bridge tests                                                         | mcp-e2e + live-macos/windows                  |
| CU-13 |  P0 | Zoom and nested Zoom use delivered raster pixels without drift                                                                                                     | ZGE C07; producer stdio Zoom regression; frame projection tests                                | mcp-e2e + live-macos                          |
| CU-14 |  P1 | Display list/switch controls capture and later pointer projection                                                                                                  | ZGE C14; selected-display and secondary-display tests                                          | live multi-display                            |
| CU-15 |  P2 | Move changes pointer position without click                                                                                                                        | ZGE C04/C15                                                                                    | live-macos/windows                            |
| CU-16 |  P1 | Finder/Explorer single-select versus double-open is independently verified                                                                                         | ZGE M01; act-verify AV05/24 and Windows equivalent                                             | live-macos/windows                            |
| CU-17 |  P2 | Triple-click selection and right-click context target are correct                                                                                                  | ZGE C15; AV43/LAV53                                                                            | live platform                                 |
| CU-18 |  P2 | Middle-click affects only the intended tab/link                                                                                                                    | ZGE C15                                                                                        | live Chromium platform                        |
| CU-19 |  P1 | Small/large scroll has correct direction, amplitude, and stable boundaries                                                                                         | ZGE C02                                                                                        | live platform                                 |
| CU-20 |  P1 | Drag moves the intended file/selection with independent oracle                                                                                                     | ZGE C04; AV13/LAV50                                                                            | live platform                                 |
| CU-21 |  P0 | Split mouse down/move/up keeps and always releases ownership                                                                                                       | ZGE C04/C15; pointer hold guard/state tests                                                    | mcp-e2e + live platform                       |
| CU-22 |  P1 | App-scoped typing supports Chinese/English/newlines/long text without foreground leakage                                                                           | ZGE C16; AV03/21 and platform suites                                                           | live platform                                 |
| CU-23 |  P1 | `set_value` replacement and `select_text` range/copy are exact                                                                                                     | ZGE C01/C06; AV04/34                                                                           | live platform                                 |
| CU-24 |  P1 | Save/undo/select-all/hold modifier use platform keys and leave no sticky modifier                                                                                  | ZGE C06/C16; M05/M08/M09/M10                                                                   | live platform                                 |
| CU-25 |  P1 | Calculator semantic actions work without foreground coordinate dependence                                                                                          | ZGE M02/C17; AV01/02/10                                                                        | live platform                                 |
| CU-26 |  P1 | Clipboard write/paste/read agrees and original clipboard is restored                                                                                               | ZGE C06; AV17; clipboard cleanup tests                                                         | live platform                                 |
| CU-27 |  P2 | Wait duration is bounded and has no input/indicator side effect                                                                                                    | ZGE C14/C18; runtime timing tests                                                              | mcp-e2e + Windows indicator lane              |
| CU-28 |  P0 | `request_access` is read-only and never prompts or actuates                                                                                                        | ZGE C08/M11; broker read-only contracts                                                        | mcp-e2e + live platform                       |
| CU-29 |  P0 | Stop latches immediately, releases held input, and leaves normal chat usable                                                                                       | ZGE C08/C18; pointer cleanup contracts                                                         | desktop-e2e + live platform                   |
| CU-30 |  P0 | Moving a window after capture makes the bound old frame fail before dispatch                                                                                       | frame provenance native gate; pointer dispatch race                                            | mcp-e2e + live-macos                          |
| CU-31 |  P0 | Unknown/expired/superseded/out-of-range coordinates all fail with zero input                                                                                       | frame registry/resolver/pointer suites; C08                                                    | mcp-e2e                                       |
| CU-32 |  P0 | Occlusion/owner change is detected and never clicks the covering window                                                                                            | frame provenance native gate; C07 owner oracle                                                 | live-macos/windows                            |
| CU-33 |  P0 | Element mutation invalidates stale state identifiers; current UI facts require an explicit new `get_app_state` observation                                         | ZGE M13/C08; action receipt/state identity tests                                               | mcp-e2e + live-macos                          |
| CU-34 |  P0 | Post-send timeout/disconnect is never blindly replayed                                                                                                             | broker delivery-state and action receipt tests                                                 | mcp-e2e fault lane                            |
| CU-35 |  P0 | Targetless `type`/`key` fails closed across focus changes                                                                                                          | keyboard schema/runtime contracts; C16 scoped positive path                                    | mcp-e2e + live platform                       |
| CU-36 |  P0 | Mid-input focus/modal changes do not redirect input                                                                                                                | app/window identity and frontmost gates                                                        | live platform race lane                       |
| CU-37 |  P1 | Similar same-app windows modify only the pinned window                                                                                                             | ZGE C13/M13                                                                                    | live-macos/windows                            |
| CU-38 |  P0 | Two ZCode/controllers cannot steal lease; stale token/socket/PID reuse fails                                                                                       | controller admission/lease/isolation suites                                                    | desktop-e2e + live controller smoke           |
| CU-39 |  P0 | Official CUA is unavailable in Subagent and available to Main Agent                                                                                                | producer runtime-scope preflight; consumer subagent policy tests                               | consumer integration                          |
| CU-40 |  P1 | Similar third-party MCP names are not blocked by official-CUA policy                                                                                               | consumer subagent computer-use policy tests                                                    | consumer integration                          |
| CU-41 |  P1 | Windows indicator appears for each Computer Use cell, backstop-clears 30s after the latest cell, and always clears on terminal/runtime failure                                | Windows operation-indicator suite                                                              | live-windows                                  |
| CU-42 |  P0 | Windows locked/non-interactive/Session 0 refuses blind operation                                                                                                   | Windows desktop/session preflight suite                                                        | live-windows                                  |
| CU-43 |  P1 | macOS background element action works; Windows app-scoped keyboard requires foreground                                                                             | macOS native workflows + Windows foreground gates                                              | live-macos + live-windows                     |
| CU-44 |  P2 | Locale/theme/narrow layout keeps entry/tool cards and macOS permission onboarding readable; permission-panel copy follows the active ZCode locale                   | UI component tests, `cua-permission-panel-i18n.test.ts`, plus visual desktop sweep              | desktop-e2e visual                            |
| CU-45 |  P1 | Linux standalone AT-SPI is tested without claiming ZCode Linux product support                                                                                     | LAV01-LAV68 and Linux readiness docs                                                           | live-linux standalone                         |
| CU-46 |  P0 | A multimodal model clicks a canvas-only target from the delivered raster without AX/DOM coordinates, model-side frame-token relay, or ancestor-raster fallback     | producer internal-frame binding contracts plus `glm-x-preview-f` canvas live lane              | mcp-e2e + live-macos model lane               |
| CU-47 |  P0 | `open_application` launches the named app deterministically: ordinary placeholder window ids are ignored, bundle identity outranks display name, localized name-only launch resolves uniquely, and the model never substitutes apps or loops over guessed names | producer ZGE M17-M20 direct/model lanes plus trajectory-step contract tests | mcp-e2e + live-macos model lane |
| CU-48 |  P0 | Anthropic transport preserves real CUA observation/action block order; an unavailable raster exposes neither image_ref nor coordinate guidance                     | deterministic adapter/core golden tests; producer MaaS echo smoke is advisory                  | consumer integration + live-provider advisory |
| CU-49 |  P0 | A concrete direct-PID identity conflict is never washed into success by a weaker application-list fallback; absent direct data may still use an exact PID fallback | producer identity conjunction tests                                                            | contract + live-macos activation              |
| CU-50 |  P0 | Every model-visible image_ref is immediately paired with its own deliverable raster; blank separators, orphan refs, and unrelated images fail closed               | adapter provider-projection tests                                                              | consumer integration                          |
| CU-51 |  P1 | Official CUA frame protection has one Host authority switch and no parallel preserve boolean                                                                       | core MCP registration contract                                                                 | consumer integration                          |
| CU-52 |  P0 | A live official macOS `request_access` missing-permission snapshot asks once before onboarding; ordinary errors and text parsers never trigger                     | producer metadata contract + consumer authority/live/UI coordinator tests                      | consumer integration + live-macos             |
| CU-53 |  P0 | `request_access` permission observation is desktop-continuous/local only; history, recovery, mobile replayable and remote workspaces create no permission side effect | protocol/service delivery-boundary tests + Electron cold/mobile representative                 | consumer integration                          |
| CU-54 |  P0 | Confirmation rechecks fresh status, opens only exact missing permissions, restarts Helper on return, and never replays or continues the task                        | permission coordinator unit + Electron manual-review                                            | consumer integration + live-macos             |
| CU-55 |  P0 | Idle Helper has no periodic health probe or timer-triggered recovery; the next CUA resolve boundary performs the bounded on-demand check while agent spawn injects process-stable pure-data credentials with zero Helper IO, without restarting Agent | default services assembly contract + producer resolver health contracts; agentProxyEnv lazy-spawn source contract | consumer integration + live-macos/windows |
| CU-56 |  P0 | Agent spawn credentials are process-stable pure data (MC-1/3/4/8): darwin stable socket + per-spawn authority; win32 stable pipe + ZCODE_CUA_WIN_HELPER_RECIPE; no Helper IO, no health verdict, no marker, no acquire; authorization-flow managed host does not feed spawn credentials | agentProxyEnv lazy-spawn source contract + stableCuaTransport pipe contracts | consumer integration + live-macos (win32 pending real-machine) |
| CU-57 |  P1 | win32 settings getStatus truth chain (MC-9): probe stable pipe -> host fork -> permission_status truth; launch failure degrades to idle:true copy | stableCuaTransport pipe contracts; full chain owned by the live lane | live-windows (pending real-machine) |

## Deterministic application launch model lane

CU-47 is split into independent setup/action/oracle cases so a broad native-app
workflow cannot hide the original regressions:

| ZGE case | Setup | Action | Blocking assertions |
| --- | --- | --- | --- |
| M17 | fresh Chrome open panel | activate the observed exact panel | complete panel identity still uses the file-panel guard; ordinary guidance contains no removed confirmation field |
| M18 | Calendar absent or running | direct historical `日历 + window_id=1`; model prompt names `日历` | direct call stays on ordinary launch path; model omits guessed `window_id`; exact bundle is `com.apple.iCal` |
| M19 | NetEase Music installed | direct/model name-only `网易云音乐app` | exact bundle is `com.netease.163music`; no translation, Finder, Spotlight, Chrome, Feishu, or substitute app |
| M20 | Maps target with conflicting direct display name | direct `bundle_id=com.apple.Maps + name=日历`; model prompt names `地图` | bundle identity wins; Calendar is not newly launched; model sends either original name-only or canonical bundle-only |

M18-M20 each run five real-model repetitions. Each repetition allows at most four
CUA calls and at most two `open_application` calls. A second open call is valid only
as one correction of a failed historical placeholder-`window_id` call, using the
same identity with `window_id` omitted. Model inference time and token count are
reported but do not decide this step-efficiency gate.

Pruned combinations:

- Windows/Linux name-only installed-app discovery: unchanged by this macOS fix;
- permission/onboarding state: owned by CU-03..CU-05 and CU-52..CU-54;
- open/save panel surface generations beyond the representative M17 path: owned by
  the M14-M17 safety suite;
- arbitrary installed-app ambiguity fixtures: deterministic resolver contract tests
  cover zero/multiple matches because mutating the live workstation application index
  is not an acceptable E2E setup.

## Mandatory regression for image-coordinate delivery

Every producer candidate must run a real MCP transport case that performs:

1. capture a raster larger than the 1280-pixel delivery edge;
2. verify the result starts with `[image, image_ref]`, followed only by truthful state/metadata;
3. Zoom using only `region` (no model-visible `frame_id`);
4. verify Zoom also starts with `[image, image_ref]` and only an optional clamp note follows;
5. click the Zoom raster using only `{type:"coordinate",x,y}`;
6. independently assert the broker receives the correctly projected native point;
7. issue a newer frame while an action is queued and assert the old internally bound action is rejected;
8. verify an explicit invalid frame id never falls back to the current frame.

The consumer must independently prove that an official frame pair is already at
the start of the model-facing tool result. A non-canonical prefix fails closed;
the consumer never lifts or reorders the pair.

## Canvas-only model lane

CU-46 deliberately separates the model contract from the transport compatibility
contract:

- The model receives the raster and submits only integer `x/y` from that exact
  image. It must not calculate Retina, display, window, CSS, or native pointer
  transforms.
- The model lane must not require it to transcribe `image_ref.frame_id`; opaque
  transport authority is not visual task input.
- Producer MCP tests independently cover an explicit valid `frame_id` and prove
  that unknown, expired, superseded, cross-session, and out-of-range values fail
  closed without falling back to the current frame.
- Coordinates and regions outside the latest raster fail closed even when a
  retained ancestor raster could contain them.
- The live fixture must be a single fixed-size HTML canvas with no actionable
  board elements. Its page-owned readout is the independent oracle for raw CSS
  click coordinates, snapped row/column, move number, and the latest three moves.
- Do not bring another desktop application to the foreground between capture and
  dispatch. If the live pixel owner changes, the expected result is
  `action_sent=false`; recapture after restoring the intended app instead of
  replaying the click.

## Platform execution rule

The macOS development lane may mark CU-01..40 and CU-44 only where their required
macOS evidence ran. CU-41..43 Windows assertions remain `not-run` until a Windows
interactive desktop executes them. CU-45 remains `not-run` until the Linux X11 /
AT-SPI workstation lane executes it. Definition validation or source inspection
cannot be reported as live platform success.

## 2026-08-21 macOS validation record

Executed against the local producer/consumer worktrees and the stable-identity
Dev Helper:

- producer unit/integration: 2942 passed, 49 skipped;
- producer Python contracts: 46 passed;
- ZGE evaluator contracts: 508 passed;
- ZGE definition catalog: 31/31 passed;
- macOS direct core: C01/C05/C06/C07/C08/C09/C10/C13/C16/C17 = 10/10;
- remaining macOS direct cases: C02/C03/C04/C12/C14/C15/C18/M12/M13 all
  passed after fixing evaluator drift and fresh-process error classification;
- common native apps: M01..M11 product cases passed; M09 cold-start initial
  environment failure passed on isolated rerun;
- consumer 0820 unit lane: 12304 passed, 11 skipped; the only two failures are
  pre-existing `v4ConversationDraftSuggestedPrompts` style assertions outside
  the CUA diff;
- consumer typecheck, desktop E2E typecheck, and lint: 0 errors;
- real `glm-x-preview-f` 12px lane: M1..M5 all hit once using image-first
  screenshot/Zoom and `{type:"coordinate",x,y}` only;
- real `glm-x-preview-f` canvas lane: a 15×15 Safari canvas received seven
  coordinate clicks through `window_event` with no AX/DOM target. Tengen,
  bottom-right, top-edge midpoint, two half-pitch probes, a +4 raster-pixel
  probe, and an explicit `strategy="event"` point all snapped to the intended
  intersection. The page oracle reported, in order, `(336,320)`, `(600,601)`,
  `(321,40)`, `(221,200)`, `(420,400)`, `(167,487)`, and `(480,121)` CSS pixels;
- the same canvas trace proved the provider cannot reliably relay the adjacent
  opaque frame token: the model request contained `frame-77ee3492`, while the
  model emitted a different remembered value. The internal-binding path hit the
  correct point; explicit wrong/stale ids were rejected with
  `action_sent=false`, so the fail-closed boundary remained intact;
- 0820 consumer live replay delivered the screenshot to `glm-x-preview-f` as
  `[image, image_ref, hint]` with the 151,676-byte JPEG first. An initial
  live-owner change failed with `action_sent=false`; the raster-only recovery
  path recaptured and clicked `{x:132,y:214}` via `window_event`, and the page
  oracle reported CSS `(198,200)` at intersection `(5,5)`;
- Composer lifecycle: ready state, persisted hide/restart/restore, narrow 640×800
  dark/light presentation, busy disable, and automatic post-task recovery passed.

Retained evidence:

- producer ZGE reports under `evals/zcode-gui-eval/artifacts/`, notably
  `cua-internal-frame-direct-core-final.json`,
  `cua-internal-frame-c18-final3.json`, and
  `cua-internal-frame-m12-final.json`;
- consumer dogfood report under
  `dogfood-output/cua-comprehensive-20260821/report.md`;
- model I/O trace at
  `~/.zcode/cli/debug/model-io-sess_3a199ff0-35cf-4f1f-969b-d3b0a8b9d633.jsonl`.
- canvas model traces at
  `~/.zcode/cli/debug/model-io-sess_39975407-4287-4fc0-bbda-1ad2c2ef1fd4.jsonl`
  and
  `~/.zcode/cli/debug/model-io-sess_c2d24f67-4b69-4411-9c7a-46feaa3c49c8.jsonl`.
- 0820 image-first/recovery trace at
  `~/.zcode/cli/debug/model-io-sess_47b6badf-9faa-43c2-a252-1ad6e3c21612.jsonl`.

Not executed on this machine: CU-14 true dual-display hardware switching,
CU-41/CU-42/the Windows half of CU-43, and CU-45 Linux AT-SPI. Their platform
lanes remain mandatory and must not be inferred from the macOS pass.

## 2026-09-21 lazy startup validation record

- darwin on-machine MC-1/2/3: pending manual run (dev:desktop checklist in delivery notes)
- MC-4..7/9: pending Windows real-machine
