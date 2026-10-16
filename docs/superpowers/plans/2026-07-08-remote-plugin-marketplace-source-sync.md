# Remote Plugin Marketplace Source Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SSH plugin sync supports installed marketplace plugins whose marketplace source is local `file`, local `directory`, or synthetic `settings`.

**Architecture:** Keep marketplace plugin installation authoritative on the SSH host. Add a source mirror archive path to `IPluginSyncService`: the local service exports a normalized marketplace source directory containing `marketplace.json` and required local plugin source roots; the remote service imports it under `~/.zcode/plugins/marketplace-sources/<marketplace-id>-<hash>`, then the existing remote agent `addPluginMarketplace` and `installPlugin` calls run unchanged.

**Tech Stack:** TypeScript, Vitest, Node `fs/promises`, existing gzip tar plugin sync archive helpers, existing ZCode agent plugin protocol.

---

### Task 1: Service-Level Source Archive

**Files:**
- Modify: `packages/shared/src/plugin-sync.ts`
- Modify: `packages/services/src/plugin-sync/pluginSync.ts`
- Modify: `packages/services/src/plugin-sync/pluginSyncArchive.ts`
- Modify: `packages/services/src/plugin-sync/pluginSyncService.ts`
- Test: `packages/services/test/pluginSyncService.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that call `exportMarketplaceSourceArchive` and `importMarketplaceSourceArchive` for:
- a `directory` marketplace with a local plugin directory;
- a `settings` marketplace with a network plugin source;
- a `settings` marketplace with an unresolved local relative source that must fail without cache fallback.

- [ ] **Step 2: Run red tests**

Run: `CI=true pnpm vitest run packages/services/test/pluginSyncService.test.ts`

Expected: FAIL because `exportMarketplaceSourceArchive` / `importMarketplaceSourceArchive` do not exist.

- [ ] **Step 3: Implement minimal source archive support**

Add shared result types, interface methods, virtual tar file support for generated `marketplace.json`, local source resolution, same-marketplace dependency closure, source manifest rewriting, safe import to `~/.zcode/plugins/marketplace-sources`.

- [ ] **Step 4: Run green tests**

Run: `CI=true pnpm vitest run packages/services/test/pluginSyncService.test.ts`

Expected: PASS.

### Task 2: Remote Sync UI Flow

**Files:**
- Modify: `packages/ui/src/settings/RemotePluginSyncDialog.tsx`
- Test: `packages/ui/test/remotePluginSyncDialog.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that verify:
- `directory` marketplace summaries create candidates with source archive metadata instead of a string source input;
- syncing selected marketplace plugins exports/imports the source archive once per marketplace and calls remote `addPluginMarketplace` with the imported remote path before installing.

- [ ] **Step 2: Run red tests**

Run: `CI=true pnpm vitest run packages/ui/test/remotePluginSyncDialog.test.ts`

Expected: FAIL because the current UI only serializes `github` / `git` / `url`.

- [ ] **Step 3: Implement source mirror orchestration**

Carry marketplace source metadata on candidates. When a selected marketplace is missing remotely and has `file` / `directory` / `settings` source, call local export, remote import, `addPluginMarketplace(remotePath)`, then install and set enabled. Keep `github` / `git` / `url` on the existing path.

- [ ] **Step 4: Run green tests**

Run: `CI=true pnpm vitest run packages/ui/test/remotePluginSyncDialog.test.ts`

Expected: PASS.

### Task 3: Full Verification And Commit

**Files:**
- Modify: `docs/superpowers/specs/2026-07-06-remote-plugin-sync-design.md`

- [ ] **Step 1: Run targeted tests**

Run: `CI=true pnpm vitest run packages/services/test/pluginSyncService.test.ts packages/ui/test/remotePluginSyncDialog.test.ts`

Expected: PASS.

- [ ] **Step 2: Run required checks**

Run: `CI=true pnpm lint`

Expected: PASS.

Run: `CI=true pnpm typecheck`

Expected: PASS.

- [ ] **Step 3: Commit**

Run:

```bash
git add docs/superpowers/specs/2026-07-06-remote-plugin-sync-design.md docs/superpowers/plans/2026-07-08-remote-plugin-marketplace-source-sync.md packages/shared/src/plugin-sync.ts packages/services/src/plugin-sync/pluginSync.ts packages/services/src/plugin-sync/pluginSyncArchive.ts packages/services/src/plugin-sync/pluginSyncService.ts packages/services/test/pluginSyncService.test.ts packages/ui/src/settings/RemotePluginSyncDialog.tsx packages/ui/test/remotePluginSyncDialog.test.ts
git commit -m "feat(remote): sync local plugin marketplace sources"
```

Expected: commit succeeds.
