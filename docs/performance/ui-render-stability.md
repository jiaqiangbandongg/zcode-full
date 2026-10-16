# UI Render Stability Optimization

## Background

The 2026-06-27 DevTools trace for the big session branch shows that most of the selected main-thread time is DevTools/Inspector overhead (`CpuProfiler::StartProfiling`, `V8Console::runTask`, `v8::Debugger::*`). Project-attributed self time is much smaller, but the React Components track still shows repeated workspace-level render bursts.

Observed project-side symptoms:

- `DesktopWindowFrame` re-renders large parts of the workspace shell in repeated bursts.
- Workspace task rows re-render even when the task data is semantically unchanged.
- Each task row carries menu/tooltip structures, so row re-renders multiply Radix `ContextMenu` / `Popper` / `Tooltip` work.
- Chat composer and toolbar props recreate equivalent objects and callbacks during stream updates.

## Goals

- Keep desktop continuous and web remote replayable behavior unchanged.
- Reduce render propagation by stabilizing props at the TaskList, shell, and composer boundaries.
- Avoid mounting heavy per-row menu content until the user opens a row context menu.
- Preserve current visual design, theme behavior, i18n strings, and keyboard/pointer interactions.

## Plan

1. **Task row actions**
   - Keep `TaskList` callbacks stable across list-local state changes by reading mutable values through refs where the action only needs the latest value at invocation time.
   - Keep task row props stable when task identity, active state, pinned state, mobile active state, and visible metadata are unchanged.

2. **Task row menu cost**
   - Keep the row itself mounted as the context-menu trigger.
   - Keep `TaskListItemContextMenu` and its file/provider-path loading limited to the opened context menu.
   - Defer hover-only archive tooltip/action controls until the row is hovered or already in archive-confirming state.
   - Avoid rendering menu and hover action content for every idle task row.

3. **Workspace shell props**
   - Memoize shell `resetKeys`, render callbacks, and small object props that are passed into memoized/error-boundary children.
   - Do not change the boundary scopes or reset semantics.

4. **Composer and toolbar props**
   - Memoize equivalent action objects, submit controls, and toolbar callbacks that React DevTools reported as referentially unstable.
   - Keep all command behavior and remote/mobile behavior unchanged.

5. **Follow-up trace findings**
   - The uploaded `p6` trace still shows repeated React scheduler long tasks after excluding DevTools profiler startup and inspector overhead.
   - Layout and paint are not the dominant cost; the remaining project-side cost is React render/commit work.
   - `TaskListItem`, `ContextMenu`, `ContextMenuTrigger`, `MenuProvider`, `Popper`, `ControlHintTooltip`, `TaskRenameDialog`, and `ModelConfigSelect` remain visible in repeated component render bursts.
   - Move task row context menu content and Radix context-menu ownership to list-level singletons so idle rows no longer each carry a menu root/trigger/content tree.
   - Mount task rename dialogs only while a rename is active.
   - Compare task row display fields semantically so equivalent task meta object replacement does not re-render unchanged rows.
   - Render model selector menu content only while the dropdown is open.

## Verification

- Add targeted render-stability tests for TaskList row props and TaskListItem context-menu content mounting.
- Add follow-up tests proving list rows do not mount per-row context menus, rename dialogs are closed-state unmounted, equivalent task meta references do not re-render a row, and model menu content is not built while closed.
- Run the affected tests first to confirm they fail before implementation.
- Run targeted UI tests after implementation.
- Run `pnpm typecheck` and `pnpm lint` before committing.

## 2026-06-28 p9 Trace Follow-up

The uploaded `p9` DevTools trace shows the previous task-list/sidebar work is effective for the recorded scenario: task row and workspace task-section components are no longer the dominant React component costs. After discounting DevTools profiler startup and React DevTools timing overhead, the remaining user-visible delay is still main-thread React work during streaming.

Observed project-side hotspots:

- `FunctionCall` time is dominated by `react-dom_client.js` scheduled work; layout and paint are not the bottleneck.
- Interaction handlers are short, but pointer/scroll events land between repeated 60-128 ms React `RunTask` blocks, so INP is delayed by streaming render pressure.
- `ChatBottomDock` still receives freshly-created prop objects and JSX children from `ChatView` on each render.
- `ToolbarControls` still receives an inline `codingPlanUsageRemaining` object and inline provider/usage callbacks; it also recreates portal children and thought-level callbacks during parent renders.
- `ChatViewConversation` recreates `renderHistoryLoader` and `renderTurnGroup` callbacks, which prevents `ChatConversationContent` from becoming a stable boundary when streaming updates are unrelated to old turn groups.

Follow-up repair plan:

- Memoize `ChatBottomDock` prop objects and JSX controls in `ChatView`, then make `ChatBottomDock` itself a memo boundary.
- Memoize toolbar usage callbacks and `codingPlanUsageRemaining` in `ChatInputToolbar`.
- Memoize portal/control subtrees inside `ToolbarControls` and wrap the component with `memo`; keep the model menu deferred until open.
- Memoize `ModelConfigSelect` so unchanged model picker props do not rerender when context usage changes.
- Memoize conversation render callbacks and wrap `ChatConversationContent` with `memo`, preserving existing streaming, history loading, search, and remote-control behavior.

## 2026-06-28 p10 Trace Follow-up

The uploaded `p10` trace was recorded on top of `834994d60`. The previous changes are partially effective: `ChatBottomDock` no longer appears in the React Components track, and first-party `localhost` main-thread time is lower than `p9`. The remaining delay is still JavaScript/React work rather than browser layout or paint.

Observed remaining hotspots:

- `ToolbarControlsComponent` still rerenders during streaming because model/config change callbacks are referentially unstable, and `codingPlanUsageRemaining.entitlements` is deeply equal but recreated.
- `ModelConfigSelectComponent` still rerenders because its `onValueChange` prop changes with the toolbar callback.
- The old message-level rewind callback was one source of streaming prop churn; that UI entry has since been removed, so current conversation render work should be checked against the remaining toolbar, summary, and visible active-turn paths.
- CPU sampling also shows workspace chrome and hidden overlay/dialog trees (`WorkspaceSidebarFooter`, `WorkspaceSidebar`, `CommandCenterDialog`, `WebRemoteControlDialog`, feedback dialogs, Radix dialog/tooltip/menu primitives) being re-executed during chat streaming. These are parent-render fanout costs, not layout/paint costs.

Follow-up repair plan:

- Add a tiny stable event callback hook for UI callbacks that only need latest values when invoked.
- Use the stable event hook for toolbar model/config callbacks and conversation rewind callbacks.
- Stabilize filtered Coding Plan usage entitlement arrays by semantic keys before crossing the toolbar memo boundary.
- Add memo boundaries to workspace shell chrome and shared overlay/dialog components that do not need to rerender for every chat token batch.

## 2026-06-28 p12 Trace Follow-up

The uploaded `p12` trace shows the p10 follow-up changes are effective for the old hotspots: `TaskList*`, `WorkspaceSidebar*`, `ModelConfigSelectComponent`, and `ToolbarControlsComponent` no longer dominate the React Components track. `ChatBottomDockComponent` is reduced to the expected inline-layout transitions. After discounting DevTools profiler startup, inspector events, and unattributed profiling-like long tasks, the remaining project-side delay is concentrated in chat content rendering and forced style/layout work.

Observed remaining hotspots:

- `MarkdownTable` recreates scroll/resize observers whenever streaming markdown replaces `children`, then immediately reads `scrollWidth` / `clientWidth`. This shows up as repeated `markdown-table.tsx` callback time and contributes to `UpdateLayoutTree` / `Layout`.
- `ChatViewSummaryPanel` remains a hot component because summary arrays and variant callbacks cross the panel boundary with new references even when their visible content is unchanged.
- The active streaming turn still rerenders chat message/tool-call components as real `parts` / `toolCalls` change. This is expected, but old turns and summary chrome should not be pulled into the same render burst.

Follow-up repair plan:

- Keep `MarkdownTable` observers mounted for the table lifetime instead of keying the observer effect to `children`; store the latest measurement callback in refs and skip `setMaskState` when the resolved mask state is unchanged.
- Reuse goal verification summary arrays when their semantic signatures are unchanged, so streaming body changes do not cause deeply equal summary props to cross memo boundaries.
- Stabilize the summary panel variant callback in `ChatView`, wrap `ChatViewSummaryPanel` with `memo`, and memoize small object/function props inside the panel that React DevTools reported as referentially unstable.

## 2026-06-28 p13 Trace Follow-up

The uploaded `p13` trace was recorded on top of `8f858f9fb`. The previous React render-stability fixes are effective: `ChatViewSummaryPanel` dropped from repeated render bursts to the expected two variant/layout renders, and the old `ChatViewConversation` / `Collapsible` / `Tooltip` fanout is no longer dominant. The remaining user-visible delay has moved from React component execution to browser style/layout work over a large DOM.

Observed remaining hotspots:

- Three long project-side layout tasks spend roughly 90 ms each in `UpdateLayoutTree` plus `Layout`, with about 13k elements recalculated and about 22k layout objects dirty.
- `DOMStats` reports about 13.8k elements, a single `DIV` with 1634 children, and a deep image path from file icons. This points to large visible chat/tool content still participating in layout.
- The trace contains non-composited animations from `transition-all` on the Git status action row. Chrome reports `scrollbar-color` as an unsupported animated property, which forces style/layout work.
- The summary panel expand/collapse transition animates `max-height`; Chrome reports `max-height` as unsupported for compositor animation, so opening or resizing the panel can relayout the whole document.
- Chat turn shells need explicit containment at the chat content / turn boundary, while avoiding full virtualization because native find, scroll restoration, fork/rewind anchors, and web remote replayable snapshots depend on the existing DOM semantics. Do not use paint containment on the turn shell: wide markdown tables are allowed to overflow the normal message text width and must remain visible.

Follow-up repair plan:

- Replace `transition-all` on the Git action row with color-only transitions so hover/state changes do not animate scrollbar/layout-related properties.
- Remove `max-height` from summary panel shell transitions. The panel may still snap between compact and expanded heights, but border/background/shadow transitions remain.
- Add explicit `contain: layout style` boundaries around chat content and turn content. Avoid `content-visibility:auto`, `contain:paint`, and `contain:size` on turn shells so scroll height, message sizing, and visible table overflow semantics are unchanged.

## 2026-06-28 Runtime CDP Follow-up

The live app was inspected through Electron CDP after reproducing the resize gesture: double-clicking the application edge blank area to shrink and grow the window. Deep DOM traversal, including open shadow roots, matched the trace-scale DOM count and found the current large container:

- `document > shadow(diffs-container) > DIV[data-gutter]` has 1634 direct children.
- `document > shadow(diffs-container) > DIV[data-content]` has 1634 direct children and about 8.3k descendants.
- The host is the code-viewer tab inside the right side pane. Its rect was roughly `x=1737, width=486` while the viewport was `1745px` wide, so only a narrow sliver was visible but the full `@pierre/diffs` DOM still participated in style/layout.
- The 1634 rows came from the `FILE_VIEWER_CHUNK_BYTES = 128 * 1024` file preview chunk used when this trace was captured; changing chunk size or virtualizing `@pierre/diffs` would affect visible code navigation, comments, search, and scroll anchoring, so that was not the first repair.

As of 2026-07-28, ordinary text preview no longer renders transport chunks as separate documents: files up to `256KB` render once as a complete document, while larger files show a bounded-preview message. The heavy-content visibility gate remains necessary because an allowed complete document can still contain many rows.

Follow-up repair plan:

- Keep the side-pane shell, tabs, source state, and file read state mounted so existing animations and tab memory remain stable.
- Gate only the heavy PreviewPane body. A code-viewer tab may render `PreviewPaneContent` only when its tab is active, the side pane is logically visible, and the side pane has enough viewport-intersecting inline width.
- Preserve scroll metrics with a lightweight spacer while the heavy body is deferred, then restore `scrollTop` when the pane becomes visible again.
- Skip auto-loading adjacent file chunks while the heavy body is deferred; otherwise an empty body can look like an under-filled viewport and trigger unnecessary hidden reads.
