# Windows Close-to-Tray Default-On Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Windows close-to-tray for every installation once, then preserve the user's subsequent on/off choice across future launches and upgrades.

**Architecture:** The shared app-settings schema owns a one-time migration keyed by `closeToTrayOnWindowsMigrationInitialized`. The setting service detects legacy raw files and persists the migrated value through its serialized write queue; UI and Electron bootstrap fallbacks match the canonical `true` default.

**Tech Stack:** TypeScript, Zod, React, Electron, Vitest, pnpm.

## Global Constraints

- The migration must set legacy missing/`true`/`false` values to `true` exactly once.
- After the marker is persisted, an explicit `false` must remain `false`.
- The behavior remains Windows desktop-only and must not alter web/mobile remote-control or realtime delivery semantics.
- Run `pnpm typecheck` and `pnpm lint` before completion.

---

### Task 1: Shared settings migration

**Files:**
- Modify: `packages/shared/test/validation.test.ts`
- Modify: `packages/shared/src/validationAppSettings.ts`
- Modify: `packages/shared/src/protocol.ts`

**Interfaces:**
- Produces: `AppSettings.closeToTrayOnWindowsMigrationInitialized?: boolean`
- Produces: parsed defaults `{ closeToTrayOnWindows: true, closeToTrayOnWindowsMigrationInitialized: true }`

- [ ] **Step 1: Write the failing schema test**

Add assertions that `{}`, legacy `{ closeToTrayOnWindows: false }`, migrated false, and migrated true resolve respectively to `true`, `true`, `false`, and `true`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run packages/shared/test/validation.test.ts`

Expected: FAIL because the current default and legacy false both resolve to `false`.

- [ ] **Step 3: Implement the minimal schema migration**

Add a preprocess migration that returns this shape when the marker is absent:

```ts
{
  ...raw,
  closeToTrayOnWindows: true,
  closeToTrayOnWindowsMigrationInitialized: true,
}
```

Define both schema fields and document the marker in `AppSettings`.

- [ ] **Step 4: Re-run the focused test and verify GREEN**

Run: `pnpm vitest run packages/shared/test/validation.test.ts`

Expected: PASS.

### Task 2: Persist migration through the settings queue

**Files:**
- Modify: `packages/services/test/settingService.test.ts`
- Modify: `packages/services/src/setting/settingService.ts`

**Interfaces:**
- Consumes: the shared schema migration from Task 1.
- Produces: first `get()` of a legacy file atomically persists `closeToTrayOnWindows: true` and `closeToTrayOnWindowsMigrationInitialized: true`.

- [ ] **Step 1: Write the failing persistence test**

Create a legacy settings file containing `closeToTrayOnWindows: false`, call `get()`, assert the returned and on-disk values are migrated, call `update({ closeToTrayOnWindows: false })`, and assert a fresh service preserves the migrated `false`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run packages/services/test/settingService.test.ts`

Expected: FAIL because the existing persistence detector only recognizes the optimize-agent migration.

- [ ] **Step 3: Extend migration persistence metadata**

Detect both one-time migrations from the raw settings value, persist schema output when either is pending, and keep the queued re-read before writing so concurrent patches are preserved.

- [ ] **Step 4: Re-run the focused test and verify GREEN**

Run: `pnpm vitest run packages/services/test/settingService.test.ts`

Expected: PASS.

### Task 3: Align consumers and verify the feature

**Files:**
- Modify: `packages/ui/src/SettingsPage.tsx`
- Modify: `packages/desktop/src/main/index.ts`
- Verify: `docs/windows-tray.md`

**Interfaces:**
- Consumes: effective `AppSettings.closeToTrayOnWindows` from the setting service.
- Produces: UI toggle and main close handler both fall back to enabled if settings cannot provide a value.

- [ ] **Step 1: Change UI and main-process fallbacks to `true`**

Set the React state initializer, loaded-setting fallback, main module default, and bootstrap fallback to `true`.

- [ ] **Step 2: Run focused and affected tests**

Run: `pnpm vitest run packages/shared/test/validation.test.ts packages/services/test/settingService.test.ts packages/desktop/test/desktopWindowLifecycle.test.ts`

Expected: PASS.

- [ ] **Step 3: Run repository gates**

Run: `pnpm typecheck`

Run: `pnpm lint`

Expected: both exit 0.

- [ ] **Step 4: Amend the unpushed spec commit into one feature commit**

Stage the implementation, tests, spec, and plan, then amend with:

```bash
git commit --amend -m "feat(desktop): enable Windows close to tray by default"
```

