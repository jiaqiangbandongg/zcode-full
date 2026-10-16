# ZCode Agent Next Steps

## Current State

The product path has moved from the retired multi-agent compatibility stack to a single ZCode Agent backed by ZCode Protocol.

- `apps/zcode-cli` is a normal workspace package and exposes `zcode app-server --stdio`.
- The app host uses `IZCodeAgentService` and the V4 conversation command/projection surface; production code no longer has the retired protocol service/process-manager modules.
- Desktop and remote workspace runtimes launch only the bundled GLM/ZCode Agent runtime plus required tools such as ripgrep.
- Retired third-party runtime installers, adapter entrypoints, proxy traffic, agent switching UI, and old runtime manifests have been removed from the current product path.
- Canonical conversation state comes from V4 snapshots/events. The renderer materializes it through `packages/ui/src/v4/conversationProjectionStore.ts` and `sessionDataLayer.ts`; `zcodeSessionStore` only retains task-shell/session metadata that is outside the transcript projection.

## Current Document Entrypoints

- [ZCode Protocol](./zcode-protocol.md)
- [ZCode Agent App Integration](./zcode-agent-app-integration.md)
- [Task Realtime Sync](./web-remote-control/task-realtime-sync.md)
- [Web Remote Control Architecture](./web-remote-control/web-remote-control-architecture.md)
- [SSH Remote App Global State Authority](./ssh-remote-app-global-state-authority.md)

## Boundaries To Preserve

- Protocol entities remain `session`; app-level `task` is a product wrapper around session state.
- V4 conversation commands/topics on `IZCodeAgentService` are the current send/subscribe boundary. `IZCodeSessionService` remains the lifecycle/configuration facade for create, resume and model/session operations that have not moved to a V4 command.
- `IZCodeTaskService` should not become a new compatibility dumping ground. Keep it focused on task wrapper metadata, task list/index behavior, dynamic task events, queued command state, and remote replayable recovery.
- Desktop `continuous` and mobile `replayable` delivery semantics must stay separate. Mobile recovery can use snapshot/gap replay; desktop main streams should not consume mobile replay concatenation as their normal path.
- `/remote` attaches to an existing host/session. It must not start an independent agent runtime for the phone side.
- Workspace isolation must use `workspaceKey = workspaceIdentity?.trim() || workspacePath` for identity/cache/queue semantics; path execution still uses `workspacePath`.
- Service logs use `createServiceLogger(scope)` from `packages/services/src/logger/serviceLogger.ts`. High-volume protocol frames or stream chunk traces must be `debug`, not production `info`.

## Remaining Work

1. Continue removing legacy `sendPrompt`/task-stream consumers after the equivalent V4 command/topic path has production and recovery coverage.
2. Keep owner/lease/queued command routing for mobile remote and bot paths until the ZCode session realtime contract has equivalent stale-run and blocking-request protection.
3. Keep fork, compact, rewind, permission/elicitation responses, checkpoint/file-change details, usage, and structured errors on the V4 schemas; do not add new behavior to the deprecated legacy send surface.
4. Audit any remaining legacy test names or migration fixtures before deleting the last task-wrapper compatibility surface.
5. When a future cleanup removes the remaining task wrapper compatibility surface, update `IZCodeTaskService`, remote replay docs, bot bridge docs, and UI queue docs together.

## Verification

Every code stage still needs:

- `pnpm typecheck`
- `pnpm lint`

Add targeted tests based on impact:

- Protocol: `packages/shared/test/zcodeProtocol.test.ts`
- App service: `packages/services/test/zcodeProtocolClient.test.ts`, `packages/services/test/zcodeAgentService.test.ts`, `packages/services/test/zcodeSessionService.test.ts`
- UI: chat, toolbar, stream, permission, queue, and remote restore tests
- Desktop/remote: host process, remote session, task realtime, owner command, and runtime asset tests
- zcode-cli: `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts` plus affected core/runtime tests
