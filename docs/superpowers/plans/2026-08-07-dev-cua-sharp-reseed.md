# Dev CUA Sharp Reseed Implementation Plan

> **Execution:** Implement inline in the current branch, following test-driven development and preserving the approved design in `docs/superpowers/specs/2026-08-07-dev-cua-sharp-reseed-design.md`.

**Goal:** Make Sharp survive the desktop dev startup filesystem reseed so CUA screenshot and zoom tools remain available after every restart.

**Architecture:** Add one dev-only staging entry that reuses the production Sharp closure copier to prepare the CUA plugin source tree. Invoke it from the shared desktop-agent preparation script before Electron starts; leave bootstrap's generic atomic seed implementation unchanged.

**Tech Stack:** Node.js ESM scripts, Vitest, `node:test`, ZCode bootstrap filesystem seeding.

---

## Task 1: Lock the dev staging contract with failing tests

**Files:**

- Create: `packages/desktop/test/dev-cua-plugin-runtime.test.ts`
- Modify: `packages/desktop/test/runtime-asset-scripts.test.ts`
- Test: `packages/desktop/test/dev-cua-plugin-runtime.test.ts`
- Test: `packages/desktop/test/runtime-asset-scripts.test.ts`

- [ ] Add a test that creates a temporary plugin root and calls `stageDevCuaPluginRuntime` with `ZCODE_CUA_DEV_MODE=1`.
- [ ] Assert the returned package list includes `sharp` and the platform native package.
- [ ] Load Sharp through `createRequire(<temporary-plugin>/package.json)` and assert its native `versions.vips` value exists.
- [ ] Add a no-op test proving an unset dev flag leaves the temporary plugin root untouched.
- [ ] Add a source-wiring assertion proving `build-desktop-agent-cli.mjs` imports and calls the staging entry.
- [ ] Run the focused tests and record the expected failure because the staging entry does not exist yet.

## Task 2: Implement the dev-only source preparation

**Files:**

- Create: `scripts/stage-dev-cua-plugin-runtime.mjs`
- Modify: `scripts/build-desktop-agent-cli.mjs`
- Test: `packages/desktop/test/dev-cua-plugin-runtime.test.ts`
- Test: `packages/desktop/test/runtime-asset-scripts.test.ts`

- [ ] Export `stageDevCuaPluginRuntime({ env, platform, arch, desktopPackageRoot, pluginRoot })`.
- [ ] Return an empty list without filesystem mutation unless `ZCODE_CUA_DEV_MODE === "1"`.
- [ ] Validate the CUA plugin manifest before staging so startup fails clearly on a broken source layout.
- [ ] Delegate package selection and copying to `stageSharpIntoBundledAgents`; do not duplicate the native dependency matrix.
- [ ] Add a Chinese bug-cause comment explaining why the source, rather than only the cache, must contain Sharp.
- [ ] Invoke the staging function exactly once after every successful desktop-agent build path and before Electron startup.
- [ ] Run the focused tests until green.

## Task 3: Prove the real bootstrap reseed preserves Sharp

**Files:**

- Modify: `apps/zcode-cli/packages/bootstrap/tests/plugins.test.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/plugins.test.ts`

- [ ] Build a temporary Electron-style `resources/glm/packages/zcode-cua-plugin` source fixture.
- [ ] Use the real dev staging entry to place the platform Sharp closure into that source.
- [ ] Run `resolveOfficialPluginRoots` against a temporary plugin storage root, exercising the real atomic filesystem seed path.
- [ ] Assert the resulting official cache contains the runtime closure and load Sharp with `createRequire` from the cached plugin package.
- [ ] Add a Chinese comment capturing the original failure sequence: direct cache staging worked, restart reseed then deleted it.
- [ ] Run the focused bootstrap test until green.

## Task 4: Serialize concurrent official plugin reseeds

**Files:**

- Create: `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-seed-lock.ts`
- Create: `apps/zcode-cli/packages/bootstrap/tests/official-plugin-seed-lock.test.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/official-plugin-seed-lock.test.ts`

- [ ] Add a real filesystem test where a child process releases an existing version lock and the waiting action runs afterward.
- [ ] Add a stale-lock takeover test so a crashed process cannot block startup indefinitely.
- [ ] Implement an atomic directory lock with bounded waiting and stale-lock recovery.
- [ ] Move the current-marker recheck inside the version lock so only one process performs the expensive replacement.
- [ ] Classify Windows `EPERM` and `EBUSY` rename failures as transient replacement races.
- [ ] Re-run the focused bootstrap tests.

## Task 5: Verify the full repository and live dev runtime

**Files:**

- Verify only; no planned source changes.

- [ ] Run the CUA cache sync Node test.
- [ ] Run the focused desktop and bootstrap tests.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.
- [ ] Stop the current dev processes without touching unrelated processes.
- [ ] Restart with `ZCODE_CUA_DEV_MODE=1` and `ZCODE_CUA_DEV_ROOT=C:\Users\dev\zcode-cua`.
- [ ] Confirm the source plugin and freshly reseeded live cache both resolve Sharp.
- [ ] Inspect the new dev log for Helper readiness and absence of `Cannot find module 'sharp'`.
- [ ] Review `git diff`, ensure only intended tracked files changed, and commit with a Conventional Commit message.
