# Built-in Plugin Uninstall & Plugin Update — Design

> Date: 2026-06-29
> Status: Draft v2 (revised after review; pending user review + plan)
> Scope: ZCode plugin management page — (1) allow uninstalling built-in
> (official/bundled) plugins, (2) surface per-plugin update in the UI.

## Problem

The plugin management page currently lets users install/uninstall **marketplace**
plugins and enable/disable any plugin, but:

1. **Built-in plugins cannot be uninstalled.** Built-in (`source: "official"`)
   plugins are seeded from the app bundle and only have an enable/disable toggle.
   The uninstall button is hidden for them, and uninstall no-ops because built-ins
   are not in the installed-records state file.
2. **There is no update affordance.** A per-plugin update path exists in the
   backend protocol (`pluginsUpdate`) but is unwired to the agent service, store,
   and UI, and there is no "update available" detection.

This design adds both, end to end.

## Two hard constraints discovered in code

### C1. Built-ins re-seed on every resolve — AND multiple readers materialize them

`seedBundledOfficialPlugins` (`bootstrap/src/app/bundled-plugins.ts`) runs on every
`resolveZCodePlugins` via `resolveOfficialPluginRoots`, writing each bundled plugin
into `storageRoot/cache/<marketplace>/<name>/<version>` (skipped only when a content-
hash marker matches). **Deleting cache files is futile — the next resolve re-creates
them.**

Critically, **more than one reader** materializes or scans official plugins, so a
suppression mechanism must thread through **all** of them or a built-in keeps
showing up / running:

- `bootstrap/src/plugins.ts` `resolveZCodePlugins` → `resolveOfficialPluginRoots` → `seedBundledOfficialPlugins`.
- `bootstrap/src/app/startup-marks.ts:24` `resolveStartupPlugins` → `resolveOfficialPluginRoots` (independent call).
- `bootstrap/src/app/plugin-facade.ts` in-session facade (caches `enabledPlugins`).
- `packages/services/src/skills/skillsService.ts:818` `resolvePluginSkillRootDescriptors` — **directly** calls `scanOfficialPluginCacheRoots(pluginStorageRoot)` and force-default-enables official ids via `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`.
- `packages/services/src/commands/commandsService.ts:406` `resolvePluginCommandRootDescriptors` — same pattern.

### C2. UI installed list/detail renders from `plugins/list`, not the overview

`PluginsSection.tsx` selects the detail plugin from `plugins` (`ZCodePluginInfo`,
from `plugins/list`). Extra per-plugin fields are join-patched by id (see
`installedAt` at `PluginsSection.tsx:118`). So any new `updateAvailable` field must
either be added to `ZCodePluginInfo` or join-patched the same way — putting it only
on the overview's `installedPlugins` will not reach the detail panel.

## Decisions (locked with product)

| Question                                    | Decision                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Uninstall built-in" semantics              | **Permanent + reversible hide; full purge of plugin user state on uninstall.** Persistent suppression survives restart and app upgrades; cache files deleted; `enabledPlugins[id]`, `options[id]`, and the plugin `data/` dir are removed. Restore re-seeds a clean plugin (config/data NOT restored — uninstall fully clears).             |
| Update detection                            | **Detect & badge** — show only when newer.                                                                                                                                                                                                                                                                                                  |
| Update scope                                | **Marketplace (`cache`) plugins only.**                                                                                                                                                                                                                                                                                                     |
| Update freshness                            | **Cached manifest**; a "Check for updates" action re-pulls on demand.                                                                                                                                                                                                                                                                       |
| Restore an uninstalled built-in             | **Restore via catalog** — but through a dedicated restore action, not the marketplace install path (see Restore below).                                                                                                                                                                                                                     |
| Non-semver version diff                     | Show **"version changed"**, not "update available" (only `semver.gt` shows "update available").                                                                                                                                                                                                                                             |
| Official marketplace name                   | **Locked** — user-added marketplaces may not claim `zcode-plugins-official` / `claude-plugins-official`.                                                                                                                                                                                                                                    |
| Installed record vs built-in classification | **`installed_plugins.json` wins.** An exact installed record is always uninstalled through the marketplace path, even when its cache lives under `zcode-plugins-official`; only ids without an installed record may enter built-in suppression. Marketplace uninstall also removes a stale suppression marker left by older buggy versions. |
| Update vs running session                   | **Next session only** — update applies to future sessions; UI shows a "takes effect in new sessions" note.                                                                                                                                                                                                                                  |
| Concurrency safety                          | **Lightweight lock** — in-process per-storageRoot serialization (async mutex) around install/update/uninstall/restore. Cross-process file lock is a non-goal.                                                                                                                                                                               |

## Architecture

### Suppression state — single source of truth in user config

Add `plugins.suppressedBuiltins: string[]` to user config (beside
`enabledPlugins`/`options`; same file + atomic-write helpers). User config is never
overwritten by app upgrades, so suppression survives upgrades.

A **shared resolver** exposes the suppression set + the resolved official roots so
the CLI bootstrap AND the desktop services layer apply identical logic (no
duplicated suppression code). Concretely:

- `resolveOfficialPluginRoots({ storageRoot, suppressedBuiltins })` skips seeding for
  suppressed ids **and** removes any leftover cache root for them.
- `writeOfficialMarketplace()` omits suppressed plugins from the synthetic manifest.
- `skillsService`/`commandsService` filter `scanOfficialPluginCacheRoots` results
  through the same `suppressedBuiltins` set (read from CLI config they already load),
  so suppressed built-ins contribute no skills/commands.

```
uninstall(built-in id)            [under storageRoot lock]
  → add id to plugins.suppressedBuiltins      (user config, atomic patch)
  → rm -rf cache dir + data dir
  → drop enabledPlugins[id], options[id]      (full purge)

every reader (resolve / startup / skills / commands)
  → reads plugins.suppressedBuiltins
  → official roots exclude suppressed; suppressed contribute nothing

restore(built-in id)              [under storageRoot lock]
  → remove id from plugins.suppressedBuiltins
  → next resolve re-seeds a CLEAN plugin (existing seeding machinery)

uninstall(marketplace id)         [under storageRoot lock]
  → exact id exists in installed_plugins.json
  → remove installed record + cache/data
  → remove enabledPlugins[id], options[id]
  → remove stale suppressedBuiltins[id] if present
```

### Restore is a dedicated action, NOT marketplace install

A suppressed built-in's cache is deleted and it is omitted from the synthetic
official manifest, so the normal install/describe flow would throw "Bundled plugin
cache directory missing" (`marketplace.ts:764` requires an existing cache dir for
`filesystem`/`sea` sources). Therefore:

- New backend op `restoreBuiltinPlugin(id)` = remove id from `suppressedBuiltins`
  (the seeder re-materializes on next resolve). No marketplace fetch.
- Overview exposes a `restorableBuiltins` list (suppressed official plugins, derived
  from `OFFICIAL_PLUGIN_DEFINITIONS` ∩ `suppressedBuiltins`) so the catalog tab can
  render a **Restore** button wired to `restoreBuiltinPlugin`, distinct from Install.

### Plugin update — wire existing backend + add detection + fail loudly

The backend `pluginsUpdate` handler (`zcode-protocol/plugins.ts:235` `updatePlugin`)
reinstalls the latest closure from the cached manifest. Changes:

- **Fail loudly (finding #3):** aggregate diagnostics from every
  `installZCodeMarketplacePlugin` call; if any target returns error diagnostics, the
  op fails and the UI keeps the badge until the installed record's version actually
  changes.
- **Detection (dual-track: version + sha):** in `getZCodePluginsOverview`, for each
  installed (`cache`) plugin, build a "latest pin" from its manifest entry — a semver
  `version` if present, else the commit `sha` from `entry.source` (`readPluginSourceSha`).
  `comparePluginUpdate` picks the axis: version present → semver compare; else sha
  present → identity (differs ⇒ `update-available`, installed has no sha ⇒
  `version-changed`); neither ⇒ `none`. **Why sha matters:** the Claude official
  marketplace pins per-plugin versions almost entirely via `source.sha` (实测 243 个
  插件中仅 14 个带顶层 `version`，192 个用 sha)，so a version-only check left ~229/243
  官方插件永远 `none`. Local-path entries (no version/sha) are Phase 2 — see
  `docs/plugin-marketplace-update-detection-handoff.md`.
- Surface `updateStatus` + `latestVersion?` (version, or short 7-char sha label) and
  join them into the UI's installed view model (per C2).
- `semver` lives in `adapters`; `comparePluginVersions` falls back to `!==` when
  unparseable. `comparePluginUpdate` wraps it for the version axis.

```
"Check for updates" (installed tab) → updateMarketplace(null) (existing git re-pull, sequential)
  → reload overview → badges refresh
update click → store.updatePlugin(id) → agentService.updatePlugin() → RPC pluginsUpdate
  → on success reload overview; on diagnostics show error, keep badge
  → note: effect applies to NEW sessions
```

### Lock official marketplace names (finding #5)

`addMarketplace` (`marketplace.ts:254`) sets `id: loaded.manifest.name` with no
guard, letting a user-added marketplace overwrite the official synthetic manifest.
Add a guard: reject (or namespace) any added/updated marketplace whose resolved
`manifest.name` is `zcode-plugins-official` or `claude-plugins-official` unless it is
the built-in seeding path. Surface a clear error in the add popover.

### Lightweight concurrency lock (finding #4)

The desktop talks to a single app-server process, so an **in-process async mutex
keyed by `storageRoot`** is sufficient to serialize install / update / uninstall /
restore (each does read-modify-write across `installed_plugins.json`, cache dirs, and
config). Wrap these mutating bootstrap ops in `withPluginStorageLock(storageRoot, fn)`.
Cross-process locking and version-rollback journaling are explicit non-goals for this
iteration (tracked in Known limitations).

## Implementation surface

### CLI (`apps/zcode-cli`)

1. `adapters/src/config/schema.ts` (`pluginsSchema`): add
   `suppressedBuiltins: z.array(z.string().min(1)).optional()`.
2. `contracts/src/plugins/index.ts` (`PluginConfig`): add
   `suppressedBuiltins: string[]` (normalize to `[]`).
3. `adapters/src/config/file-config.adapter.ts`: add
   `addSuppressedBuiltinInFileConfig` / `removeSuppressedBuiltinInFileConfig`
   (atomic, idempotent).
4. `bootstrap/src/app/bundled-plugins.ts`: `seedBundledOfficialPlugins` /
   `resolveOfficialPluginRoots` accept `suppressedBuiltins`; skip + rm suppressed;
   `writeOfficialMarketplace` omits suppressed.
5. `bootstrap/src/plugins.ts`:
   - `resolveZCodePlugins` passes `config.plugins.suppressedBuiltins` through.
   - `uninstallZCodeMarketplacePlugin`: when `source !== "cache"`, suppress + purge
     (bypassing the current installed-records `return null`); under storage lock.
   - new `restoreBuiltinPlugin`.
   - `getZCodePluginsOverview`: compute update status + `restorableBuiltins`; add
     `semver` + `compareVersions`.
   - `updatePlugin` aggregates diagnostics and fails on error.
   - add `withPluginStorageLock` and wrap mutating ops.
6. `adapters/src/plugins/marketplace.ts` `addMarketplace`/`updateMarketplace`: guard
   official names.

### Shared services layer (`packages/services`)

7. `skills/skillsService.ts` + `commands/commandsService.ts`: filter official cache
   roots through `suppressedBuiltins` (from the CLI config they already read).
   Prefer a shared helper so suppression logic is not duplicated.

### Protocol (`packages/shared/src/zcode-protocol/index.ts`)

8. `zcodeInstalledPluginSummarySchema`: add `updateAvailable?`, `latestVersion?`.
   Consider adding the same to `ZCodePluginInfo` (or join in UI per C2).
9. Overview result: add `restorableBuiltins` (array of available-plugin summaries).
10. New `pluginsRestoreBuiltin` method (params: workspace + pluginId). `pluginsUpdate`
    schema already present.

### Services client (`packages/services/src/zcode-agent/`)

11. `zcodeAgent.ts` (`IZCodeAgentService`): add `updatePlugin`, `restoreBuiltinPlugin`.
12. `zcodeAgentService.ts`: implement both via `client.request(...)` with the 5-min
    plugin timeout.

### UI store (`packages/ui/src/store/pluginManagementStore.ts`)

13. Add `updatePlugin(id)` and `restoreBuiltin(id)` actions (mirror `installPlugin`).

### UI components (`packages/ui/src/settings/`)

14. Build an enriched installed view model that joins `plugins/list` with overview
    update fields (C2).
15. `InstalledPluginManagement.tsx`: Update badge + button when `updateAvailable`
    (cache only) with "version changed" variant; "takes effect in new sessions" note;
    built-in detail now shows Uninstall.
16. `PluginsSection.tsx` `uninstallable` (~L398): broaden so **official** built-ins
    are uninstallable (`inline` stays non-uninstallable).
17. Catalog tab: render `restorableBuiltins` with a **Restore** button → `restoreBuiltin`.
18. "Check for updates" button on installed tab → `updateMarketplace(null)`.
19. Uninstall confirm dialog copy for built-ins: make clear it fully removes plugin
    data/config and the plugin will be re-downloadable/restorable.
20. i18n strings.

## Testing

- **bundled-plugins / resolve (vitest):** suppressed built-in stays gone across a
  simulated re-resolve and re-seed; restore re-materializes a clean plugin; cache+data
  removed on uninstall; `writeOfficialMarketplace` omits suppressed.
- **services layer:** skills/commands scanners exclude suppressed built-ins.
- **config:** suppressed-builtin add/remove patches atomic + idempotent.
- **overview detection:** `update-available` only when manifest version strictly
  greater; `version-changed` on non-semver; none on equal.
- **update handler:** aggregates diagnostics; fails on error; badge persists until
  version changes.
- **marketplace name guard:** adding a manifest named `zcode-plugins-official` is
  rejected.
- **lock:** concurrent uninstall+update on the same storageRoot serialize without
  corrupting `installed_plugins.json`.
- **services client:** `updatePlugin` / `restoreBuiltinPlugin` issue correct RPCs.
- **UI:** Update badge/button + "new sessions" note; built-in Uninstall; restorable
  built-in shows Restore in catalog; update existing mocks.
- Run `npm run lint && npm test` in `apps/zcode-cli`; UI/services package tests.

## Known limitations (deferred, tracked here)

- **Cross-process locking / rollback journaling** not implemented (in-process lock
  only). A crash mid-uninstall can leave config/cache briefly inconsistent; the next
  resolve self-heals seeding, but a half-written `installed_plugins.json` is out of
  scope to repair transactionally here.
- **Marketplace trust hardening** (signed manifests, pinned SHA, reject HTTP for
  executable-hook sources, downgrade protection) beyond name-locking is out of scope.
- **Dependency pruning / reverse-dependency guards on update** not handled; update
  reinstalls the closure without removing now-orphaned deps.
- **Manifest-driven "update plan"** (preview of all pending updates with old/new
  versions, source revision, dependency impact) is a future enhancement; this
  iteration does per-plugin update + per-marketplace refresh.

## Non-goals

- No version comparison UI for built-ins (they track app version).
- No auto-update / background update checks.
- No change to the (still-hidden) plugin-import dialog.
