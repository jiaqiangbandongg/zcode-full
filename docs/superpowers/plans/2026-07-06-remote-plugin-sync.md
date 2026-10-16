# SSH Remote Plugin Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit SSH remote sync for user-level inline plugins.

**Architecture:** Add a restricted `IPluginSyncService` parallel to skill/MCP sync. Local base services enumerate/export user inline plugins; remote workspace services status/import the archive into remote `~/.zcode/plugins` and remote user config.

**Tech Stack:** TypeScript, Vitest, React settings UI, existing RPC service descriptors, existing remote service collection.

## Global Constraints

- Spec before code lives at `docs/superpowers/specs/2026-07-06-remote-plugin-sync-design.md`.
- V1 only supports user-level inline plugins from `~/.zcode/cli/config.json.plugins.dirs`.
- Do not sync marketplace/cache/builtin plugins, plugin data, or plugin options.
- Do not overwrite existing remote plugins.
- UI changes must follow `DESIGN.md`, support i18n, desktop, web, light and dark themes.
- Run `pnpm typecheck` and `pnpm lint` before committing.

---

### Task 1: Shared Types And Service Tests

**Files:**
- Create: `packages/shared/src/plugin-sync.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/channels.ts`
- Create: `packages/services/src/plugin-sync/pluginSync.ts`
- Create: `packages/services/test/pluginSyncService.test.ts`

**Interfaces:**
- Produces: `PluginSyncCandidate`, `PluginSyncRemoteStatus`, `PluginSyncArchiveExportResult`, `PluginSyncImportResult`.
- Produces: `IPluginSyncService` with `listLocalUserPluginCandidates`, `listRemoteUserPluginStatuses`, `exportPluginsArchive`, `importPluginsArchive`.

- [ ] Write failing tests for candidate discovery, archive import, conflict skips, symlink rejection, and enabled state sync.
- [ ] Verify tests fail because the service does not exist yet.

### Task 2: Plugin Sync Service

**Files:**
- Create: `packages/services/src/plugin-sync/pluginSyncArchive.ts`
- Create: `packages/services/src/plugin-sync/pluginSyncPath.ts`
- Create: `packages/services/src/plugin-sync/pluginSyncService.ts`
- Modify: `packages/services/src/node.ts`
- Modify: `packages/services/src/index.ts`
- Modify: `packages/services/src/accessor.ts`

**Interfaces:**
- Consumes: types and descriptor from Task 1.
- Produces: `createPluginSyncService(options?: { maxArchiveBytes?: number }): IPluginSyncService`.

- [ ] Implement config reading/writing for `~/.zcode/cli/config.json`.
- [ ] Implement manifest discovery for `.zcode-plugin`, `.claude-plugin`, `.codex-plugin`.
- [ ] Implement safe archive create/extract with size limits.
- [ ] Implement remote import with no-overwrite conflict checks.
- [ ] Run service tests until green.

### Task 3: Remote Service Wiring

**Files:**
- Modify: `packages/desktop/src/host/remoteConnectionServiceCollection.ts`
- Modify: `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts`
- Modify: `packages/desktop/src/renderer/src/remoteWorkspaceSessionServices.ts`
- Modify: `packages/desktop/test/hostRemoteWorkspaceServices.test.ts`
- Modify: `packages/desktop/test/remoteWorkspaceSessionServices.test.ts`
- Modify: `packages/server/src/remote/serverBundleDeployCheck.ts`
- Modify: `packages/server/test/remoteDeploy.test.ts`

**Interfaces:**
- Consumes: `pluginSyncService` on `IServiceAccessor`.
- Produces: remote service collections that expose the remote `pluginSyncService`.

- [ ] Add service wiring tests.
- [ ] Add remote deploy marker test update.
- [ ] Wire the service through local and remote collections.

### Task 4: UI Dialog And Entry Points

**Files:**
- Create: `packages/ui/src/settings/RemotePluginSyncDialog.tsx`
- Modify: `packages/ui/src/settings/RemoteSyncActions.tsx`
- Modify: `packages/ui/src/settings/PluginsSection.tsx`
- Modify: `packages/ui/src/WorkspaceHeaderSections.tsx`
- Modify: `packages/ui/src/WorkspaceSidebarItem.tsx`
- Modify: `packages/ui/src/i18n/locales/en-US.ts`
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`
- Create/Modify: UI tests for remote plugin sync and remote sync actions.

**Interfaces:**
- Consumes: `IPluginSyncService`.
- Produces: SSH-only “sync plugin” action and dialog.

- [ ] Write UI helper tests.
- [ ] Add i18n keys.
- [ ] Add dropdown/dialog props while keeping skill/MCP behavior unchanged.
- [ ] Refresh plugin store and related resources after sync.

### Task 5: Verification And Commit

**Files:**
- All touched files.

- [ ] Run targeted service/UI/desktop/server tests.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Review `git diff`.
- [ ] Commit with a Conventional Commit message.
