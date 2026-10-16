# ZCode Domain Cross-Products

Use this reference after `zcode-feature-graph.yaml` when scanning or planning any ZCode feature. The feature graph records curated semantic relationships; this file routes the scan into deeper domains and cross-products. Neither replaces current docs, code, or live codegraph evidence. Prefer the freshest fact/spec/architecture doc and implementation when they conflict.

## How To Use

1. Match the user request to capability aliases and declared surfaces in `zcode-feature-graph.yaml`.
2. Classify the change as presentation, option-source, draft-default, validation, commit-effect, persistence, or recovery.
3. Map the result to 1-4 deeper capability domains from the table below and read their current source docs.
4. Inspect indexed implementation with codegraph: explore graph seeds, find direct callers, and trace each UI surface to its validation and commit sink. Use depth 2 by default and depth 3 only for an unresolved critical owner.
5. Use `rg` for docs, config, generated or unindexed content after codegraph has identified the area.
6. Record state owners before enumerating: UI local state, Zustand store, host service, desktop main, relay, agent runtime, persisted file/db, remote host, or backend API.
7. Select dimensions that can change behavior or assertions. Collapse global axes with an invariant and keep representative cases.
8. Always include client and workspace boundaries when relevant: `desktop-continuous` vs `web-remote-replayable`, local vs SSH/WSL/Docker, and `workspaceIdentity` vs `workspacePath`.

## Capability Domains

| Domain | Trigger terms | Dimensions to consider | Source docs | Code seeds |
| --- | --- | --- | --- | --- |
| Architecture/process boundary | app/agent, desktop, web, host process, relay, RPC, protocol, stdio | renderer/main/host/agent ownership, local vs remote service source, direct RPC vs relay attachment | `docs/architecture/zcode-code-architecture-overview.md`, `docs/architecture/message-flow.md`, `docs/architecture/rpc.md` | `packages/shared`, `packages/services/src/node.ts`, `packages/desktop/src/host`, `packages/client`, `packages/rpc` |
| Conversation/session behavior | send, compact, goal, queue, fork, edit, stop, tool history, turn | `session.phase`, `queue.length`, `queue.autoDrain`, compact origin, goal state, target turn, tool shape, system event | `docs/conversation-protocol-declaration.md`, `docs/conversation-product-state-space.md`, `docs/testing/conversation-session-*.md` | `packages/formal-proof`, `packages/ui/src/store/zcodeSessionStore*`, `packages/ui/src/hooks/useZCodeChat*`, `packages/services/src/session/*` |
| Cross-surface UI capability | same action in chat/settings/automation/Subagent, shared picker, shared option builder | presentation vs option-source vs draft/default vs validation vs commit effect, shared component callers, surface-local state owner, commit sink, isolation invariant | `docs/feature-impact-discovery.md`, `docs/ui/chat-model-select-menu.md`, `docs/automation-edit-status.md`, `docs/subagents-built-in-model-overrides.md` | `packages/ui/src/ModelConfigSelect.tsx`, `packages/ui/src/lib/modelSelectionGroups.ts`, `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`, `packages/ui/src/settings/AutomationEditView.tsx`, `packages/ui/src/settings/SubagentsSection.tsx` |
| Model/provider/runtime config | model switch, provider, custom provider, Coding Plan, context window, thought, runtime restart | active task vs draft, surface-local default/inherit, workspace default, task config, provider registry, runtime `defaultModelRef`, native vs custom, stale model | `docs/chat/*model-resolution-chain*.md`, `docs/model-provider-*.md`, `docs/superpowers/specs/*model*.md` | `packages/ui/src/ModelConfigSelect.tsx`, `packages/ui/src/lib/modelSelectionGroups.ts`, `packages/ui/src/hooks/useModelProviders.ts`, `packages/services/src/model-provider`, `apps/zcode-cli/packages/adapters/src/model` |
| Mobile remote/replayable realtime | phone, mobile, `/remote`, reconnect, snapshot, replay, mirror, owner, permission recovery | `clientMode`, `deliveryKind`, mirror seq, stream watermark, gap recovery, owner lease, owner command, pending permissions/elicitations/commands, shared-host attachment | `docs/web-remote-control/web-remote-control-architecture.md`, `docs/web-remote-control/task-realtime-sync.md`, `docs/web-remote-control-task-command-queue.md` | `packages/shared/src/task-realtime.ts`, `packages/shared/src/web-remote-control.ts`, `packages/desktop/src/main/taskRealtimeBus.ts`, `packages/ui/src/hooks/useTaskStreamEvents.ts` |
| Queue/task command | queued prompt, send now, busy, drain, accepted queue, host command | desktop renderer-local queue vs mobile host command queue, `autoDrain`, stop/interrupted, pending permission, command status, cross-client ordering | `docs/web-remote-control-task-command-queue.md`, `docs/conversation-protocol-declaration.md`, `docs/ui/chat-message-queue.md` | `packages/ui/src/store/zcodeSessionStoreQueueSlice.ts`, `packages/ui/src/hooks/useQueuedPromptActions.ts`, `packages/ui/src/lib/zcodeTurnSteerQueue.ts`, `packages/services/src/session/zcodeTaskService.ts` |
| Workspace identity/remote runtime | workspace identity, SSH, WSL, Docker, remote session, reconnect, app global state | `workspaceIdentity`, `workspacePath`, `workspaceKey`, `remoteSessionId`, service authority, local app-global vs remote execution facts, provider registry sync | `docs/remote-workspace-session-unified-settings.md`, `docs/ssh-remote-app-global-state-authority.md`, `docs/remote/*.md`, `docs/web-remote-control/*.md` | `packages/ui/src/store/tabWorkspaceIdentity.ts`, `packages/ui/src/lib/remoteWorkspaceProviderSync.ts`, `packages/shared/src/remoteTarget.ts`, `packages/services/src/model-provider` |
| Persistence/index/snapshot | persisted data, sqlite, task list, settings, localStorage, restore, snapshot, migration | session JSON authority, task sqlite index metadata, runtime snapshot fields, settings schema, localStorage preference, remote history, migration and fallback | `docs/task/task-sqlite-index.md`, `docs/task/task-snapshot-on-demand.md`, `docs/remote-workspace-session-unified-settings.md`, `docs/superpowers/specs/2026-06-02-app-usage-db-migration-design.md` | `packages/services/src/session/taskIndexRepo.ts`, `packages/services/src/session/legacyTaskSessionFile.ts`, `packages/shared/src/workspaceSessionRestore.ts`, `packages/ui/src/root/remoteWorkspaceSessionPersistence.ts` |
| Rendering/performance | render perf, streaming, large tool input, markdown, Mermaid, background task, logs, CPU | active vs background task, delta size/count, parser/materialization budget, React store writes, snapshot payload size, production logging level | `docs/chat/message-render-performance.md`, `docs/performance/streaming-tool-input-backpressure.md`, `docs/performance/renderer-production-logging.md`, `docs/chat/mermaid-rendering.md` | `packages/ui/src/hooks/taskStreamEventHandlers.ts`, `packages/ui/src/lib/zcodeSessionProjection.ts`, `packages/shared/src/streaming-tool-input-preview.ts`, `packages/ui/src/logger.ts`, `packages/services/src/session/continuousStreamCoalescer.ts` |
| Monitoring/telemetry/usage | telemetry, monitor, ARMS, `/report`, usage stats, quota, data tracking, trace | channel (`ARMS main`, `ARMS ui_perf`, `/report agent_trace`, local usage DB, monitor API), event volume, privacy, model/task ids, retry/error attribution, range | `docs/monitoring/performance-telemetry-catalog.md`, `docs/monitoring/business-monitoring.md`, `docs/usage-stats-app-coding-plan-split.md`, `docs/bigmodel-coding-plan-usage-quota.md` | `packages/ui/src/lib/appTelemetry.ts`, `packages/ui/src/lib/messageTelemetry.ts`, `packages/ui/src/lib/uiPerfArmsTelemetry.ts`, `packages/services/src/telemetry`, `packages/services/src/usage-stats` |
| Permission/tool/MCP/subagents | approve, permission, elicitation, tool card, MCP, subagent, background agent | option response passthrough, `permissionUpdates`, pending snapshot recovery, tool lifecycle, read/write/destructive classification, MCP platform boundary, nested tool rendering | `docs/permission-project-approval.md`, `docs/mcp-platform-boundary.md`, `docs/agent-tool-call-renderer.md`, `docs/mcp-*.md` | `packages/shared/src/zcode-protocol/index.ts`, `packages/shared/src/mcp.ts`, `packages/ui/src/ToolCallBlocks*`, `packages/ui/src/store/mcpStore*` |
| UI shell/theme/locale/responsive | theme, locale, language, mobile shell, settings UI, command center, sidebar | desktop vs mobile viewport, `zai-light`/`zai-dark`/system, persisted `zcode-theme`, locale preference, i18n keys, DESIGN.md constraints, screenshot text | `docs/ui/zai-themes.md`, `docs/ui/default-theme.md`, `docs/web-remote-control/mobile-theme-control.md`, `docs/ui/*.md` | `packages/ui/src/i18n`, `packages/ui/src/useTheme.ts`, `packages/ui/src/SettingsPage.tsx`, `packages/ui/src/WebRemoteControlMobileShell.tsx` |
| Desktop lifecycle/logging/release | crash, ANR, update, log export, data directory, bundle, zoom | process role, renderer/main/host log path, crash source, update lifecycle, data dir override, OS-specific behavior | `docs/desktop/*.md`, `docs/desktop-bundle-size-architecture.md`, `docs/feedback-log-export-alignment.md` | `packages/desktop/src/main`, `packages/desktop/src/preload`, `packages/services/src/logger/serviceLogger.ts` |
| File/git/terminal/diff/feedback | file tree, diff, terminal, git, feedback ticket, screenshot | local vs remote execution path, workspace scope, binary/large file rendering, terminal lifecycle, diff source, feedback attachment privacy | `docs/ui/workspace-file-tree.md`, `docs/ui/diff-viewer.md`, `docs/ui/terminal-sessions.md`, `docs/feedback-*.md` | `packages/ui/src/workspace-file-tree`, `packages/ui/src/terminal`, `packages/services/src/git`, `packages/ui/src/feedback` |

## State Owner Checklist

| State or event | Authority | Mirrors/caches | Evidence to collect |
| --- | --- | --- | --- |
| Session messages and active turn | ZCode Agent runtime/session store | UI projection, task snapshot, replay mirror | protocol event, session snapshot, UI message tree |
| Task list metadata | Host task sqlite index | UI task list cache, optimistic overlay | `tasks-index.sqlite` row, service list result, UI list |
| Runtime recovery fields | Host runtime response-time snapshot | Mobile replayable UI store | `getTaskSnapshot.runtime`, stream watermark, pending permission/command UI |
| Desktop queued prompt | Renderer local store | none durable by default | UI queue item, send/drain logs |
| Mobile accepted queued prompt | Host runtime command queue | `pendingCommands` snapshot | enqueue ack, owner command, runtime snapshot |
| Model selected for request | Agent runtime `defaultModelRef` | toolbar value, task config, task meta, workspace default, provider registry | `session/setModel` response, protocol snapshot settings, request/model trace |
| Provider registry for remote workspace | Local desktop app-global provider service, explicitly synced to remote runtime | remote runtime overlay/cache | registry revision, remote session id, runtime model config |
| Workspace isolation key | `workspaceIdentity?.trim() || workspacePath` | tab/task/plugin/skill/cache keys | state bucket key, remote identity, path execution target |
| Theme and locale | Renderer local preference plus broadcast for app windows | DOM classes, settings UI, mobile localStorage | settings value, DOM class, i18n text |
| Telemetry | Declared event channel owner | transport queue/backend | event payload shape, sampling/aggregation rule, privacy filter |

## High-Risk Cross-Products

Use these as prompts for pairwise coverage. Do not explode every axis; prune with invariants and representative cases.

| Cross-product | Typical question for the user |
| --- | --- |
| model switch x active task send x provider registry | Should send wait for pending `session/setModel`, fail fast, or continue with the old runtime model? |
| model switch x mobile replayable restore | Is restored mobile model display read-only history, active runtime config, or a new switch target? |
| model/provider x remote workspace reconnect | After remote runtime restarts, which local provider registry revision must be reapplied before send? |
| queue x stop/interrupted x autoDrain | After stop, should queued prompts remain held, auto-drain, or require explicit send-now? |
| queue x edit/fork/compact | Does the action preserve, discard, copy, or reorder future queued intent? |
| mobile remote x permission/elicitation | If a phone reconnects after a gap, should pending blockers render from snapshot, stream replay, or both? |
| replayable mirror x snapshot payload limit | Does a truncated snapshot cover the required watermark, or must UI wait for a fresher snapshot? |
| rendering performance x large streaming tool input | Which client gets live preview, summary-only state, or final-only materialization? |
| telemetry x streaming step volume | Is the event per chunk, per step, per message, or aggregated; and does it belong in ARMS or `/report`? |
| persistence x stale task index | When index and session snapshot disagree, which source wins and what UI should show before repair? |
| theme/locale x mobile remote | Are desktop and phone preferences intentionally independent, and how should screenshots assert copy? |
| MCP/platform x web/mobile | Does the path call `IPlatformService`, shared-host attachment, or unsupported fallback? |

## Invariants To Try Before Expanding

- Relay and desktop main do not own task/session/stream/queue/snapshot business state.
- Desktop `desktop-continuous` direct stream and mobile `web-remote-replayable` recovery stream are separate semantics.
- `workspacePath` is for execution/display; `workspaceIdentity`/`workspaceKey` is for isolation.
- Task sqlite index is not the authority for session content or runtime settings.
- Queue items are future user intent; compact/edit/fork should not rewrite them unless product explicitly says so.
- Runtime snapshot fields such as pending permissions, elicitations, stream watermark, and pending commands are response-time recovery state, not persisted session JSON.
- UI telemetry and logs must respect volume and privacy; high-frequency stream details default to debug or aggregated telemetry.
- UI code should go through hooks/services/platform injection, not direct Repo/Runtime/window bridge calls.

## Useful Codegraph And Text Seeds

For indexed code, begin with exact symbols and inspect direct callers before broad impact traversal:

```text
explore ModelConfigSelect
callers ModelConfigSelect
callers buildModelSelectGroups
explore ConversationProjectionStore
impact <matched seed>, depth 2
affected tests <matched seed>
```

Interpret these as codegraph operations, not product conclusions. Compare live callers with `zcode-feature-graph.yaml` and report undeclared surfaces as graph drift.

Use focused text searches for docs, configuration, generated files, or unindexed content:

```sh
rg -n "clientMode|deliveryKind|desktop-continuous|web-remote-replayable" docs
rg -n "workspaceIdentity|workspaceKey|remoteSessionId" docs .agents
rg -n "modelSwitch|defaultModelRef|providerRegistry" docs
rg -n "pendingCommands|streamWatermark|owner command|enqueueTaskCommand" docs
rg -n "reportAppTelemetryEvent|uiPerf|agent_step|message_completion|ARMS" docs
rg -n "zcode-theme|localePreference|IntlProvider|theme-zai" docs
```
