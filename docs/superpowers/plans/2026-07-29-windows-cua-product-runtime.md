# Windows CUA Product Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the completed Windows CUA source runtime inside ZCode Windows x64/arm64 packages and start it without a local source checkout.

**Architecture:** Stage the pinned `@zcode/zcode-cua` Windows entry, native addon, and minimal external dependencies into `bundled-tools/<triplet>/cua-helper`, then package it at `resources/tools/cua-helper`. A single asynchronous resolver admits either an explicit development root or the verified packaged manifest, while the existing named-pipe Helper host remains the only lifecycle implementation.

**Tech Stack:** TypeScript, Node.js 24, Electron 41.0.3, Node-API, Win32 PE, electron-builder 26, Vitest, PowerShell/vsigntool.

## Global Constraints

- Product scope is Windows desktop-local only; do not modify SSH, WSL, Docker, remote workspace, mobile `/remote`, replayable delivery, owner, queue, snapshot, or workspace identity behavior.
- Product resources live at `resources/tools/cua-helper`; source override remains `ZCODE_CUA_DEV_ROOT`.
- Runtime manifest schema is `1`, package name is `@zcode/zcode-cua`, Electron version is `41.0.3`, and target architectures are `x64` and `arm64`.
- PE machine `0x8664` means x64 and `0xaa64` means arm64; mismatches fail the build.
- Development override misconfiguration fails closed and never falls back to product resources.
- Runtime file-system and hashing I/O is asynchronous.
- Tests precede implementation and each production bug boundary receives a Chinese cause comment.
- Run `pnpm typecheck` and `pnpm lint`; report pre-existing unrelated failures separately.

---

## File Map

- `C:/Users/dev/zcode-cua/package.json`: publishable Windows Helper entry/version contract.
- `C:/Users/dev/zcode-cua/test/windows-package-artifacts.test.ts`: packable artifact regression.
- `packages/desktop/scripts/windows-cua-helper-assets.mjs`: staging, manifest, SHA-256 and PE helpers.
- `packages/desktop/scripts/prepare-windows-cua-helper.mjs`: target-aware build entry.
- `packages/desktop/test/windows-cua-helper-assets.test.ts`: pure asset/staging tests.
- `packages/desktop/scripts/prepare-runtime-assets.mjs`: invokes Windows Helper staging after agent assets.
- `packages/desktop/package.json`: exposes `prepare:windows-cua-helper`.
- `packages/desktop/electron-builder.config.js`: packages, signs and asserts Helper assets.
- `packages/desktop/test/runtime-asset-scripts.test.ts`: packaging policy regression.
- `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts`: generalized source/product resolver and manifest validation.
- `packages/services/src/cua-permission-broker/windowsCuaDevHelperHost.ts`: generic product naming alias over the single lifecycle.
- `packages/services/src/node.ts`: enables lazy packaged Windows product runtime.
- `packages/services/test/windowsCuaDevRuntime.test.ts`: resolver fail-closed matrix.
- `packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts`: default factory/admission tests.
- `packages/services/test/windowsCuaProductHelper.integration.test.ts`: staged product root ready/health/cleanup acceptance.
- `docs/cua/windows-product-runtime.md`: current product behavior and evidence.

### Task 1: Publishable zcode-cua Windows runtime contract

**Files:**

- Modify: `C:/Users/dev/zcode-cua/package.json`
- Create: `C:/Users/dev/zcode-cua/test/windows-package-artifacts.test.ts`
- Regenerate: `C:/Users/dev/zcode-cua/dist/windows-helper.js`

**Interfaces:**

- Produces: package version `0.3.28`, export `./windows-helper`, and pack contents containing `dist/windows-helper.js`, `binding.gyp`, `src/native/ax_win.cc`, and `scripts/build-native.cjs`.

- [ ] **Step 1: Write the failing artifact test**

  Add a Vitest case that reads `package.json`, asserts version `0.3.28` and
  `exports["./windows-helper"].import === "./dist/windows-helper.js"`, then runs
  `pnpm pack --dry-run --json` and asserts the four required paths are present.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `pnpm exec vitest run test/windows-package-artifacts.test.ts`

  Expected: FAIL because version/export are absent.

- [ ] **Step 3: Add the package contract and rebuild**

  Set version to `0.3.28`, add the exact ESM subpath export, and run `pnpm build`.
  Do not add the compiled `.node` file to git; desktop target builds still compile it.

- [ ] **Step 4: Verify Task 1**

  Run:

  ```text
  pnpm exec vitest run test/windows-package-artifacts.test.ts
  pnpm typecheck
  pnpm lint
  pnpm build
  ```

  Expected: all exit `0`.

- [ ] **Step 5: Commit and publish the feature branch**

  Commit: `feat(windows): publish CUA helper runtime artifacts`

  Push `codex/windows-cua-pointer-foundation` so ZCode can pin the resulting exact commit.

### Task 2: Deterministic Windows Helper staging

**Files:**

- Create: `packages/desktop/scripts/windows-cua-helper-assets.mjs`
- Create: `packages/desktop/scripts/prepare-windows-cua-helper.mjs`
- Create: `packages/desktop/test/windows-cua-helper-assets.test.ts`
- Modify: `packages/desktop/package.json`
- Modify: `packages/desktop/scripts/prepare-runtime-assets.mjs`
- Modify: `packages/services/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: pinned `@zcode/zcode-cua-helper-runtime` at the Task 1 commit, or explicit absolute `ZCODE_CUA_DEV_ROOT`.
- Produces: `prepareWindowsCuaHelperAssets({ sourceRoot, outputRoot, targetPlatform, electronVersion })` and a schema-1 `runtime-manifest.json`.

- [ ] **Step 1: Write RED tests for staging**

  Cover successful x64 staging, missing entry/addon, wrong package name, x64/arm64
  PE mismatch, deterministic lowercase SHA-256, dependency directories, and non-Windows
  no-op behavior. Build minimal PE fixtures by writing `MZ`, a PE header offset at
  `0x3c`, `PE\0\0`, and machine at `peOffset + 4`.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run: `pnpm exec vitest run packages/desktop/test/windows-cua-helper-assets.test.ts`

  Expected: FAIL because the assets module does not exist.

- [ ] **Step 3: Implement asynchronous staging**

  Resolve the source from non-empty absolute `ZCODE_CUA_DEV_ROOT`, otherwise from
  `@zcode/zcode-cua-helper-runtime`. Validate source identity/version/artifacts,
  parse the PE machine, copy entry/addon, stage the `express` dependency closure
  plus target Sharp packages into `node_modules`, hash entry/addon, and atomically
  replace `bundled-tools/<triplet>/cua-helper`.

- [ ] **Step 4: Wire the build scripts and exact dependency pin**

  Add `prepare:windows-cua-helper`; invoke it after `prepare:agent-bundle` and
  `prepare:rg`. Update `@zcode/zcode-cua-helper-runtime` to the exact remote Task 1
  commit and regenerate the lockfile.

- [ ] **Step 5: Verify Task 2**

  Run:

  ```text
  pnpm exec vitest run packages/desktop/test/windows-cua-helper-assets.test.ts
  $env:ZCODE_CUA_DEV_ROOT='C:\Users\dev\zcode-cua'; pnpm --filter @zcode/desktop prepare:windows-cua-helper
  ```

  Expected: tests pass and staged manifest reports win32/x64, Electron 41.0.3,
  package 0.3.28, matching hashes and PE machine.

- [ ] **Step 6: Commit**

  Commit: `build(windows): stage packaged CUA helper runtime`

### Task 3: Product runtime resolver and single lifecycle

**Files:**

- Modify: `packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts`
- Modify: `packages/services/src/cua-permission-broker/windowsCuaDevHelperHost.ts`
- Modify: `packages/services/src/cua-permission-broker/index.ts`
- Modify: `packages/services/src/node.ts`
- Modify: `packages/services/test/windowsCuaDevRuntime.test.ts`
- Modify: `packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts`
- Modify: `packages/services/test/cuaPermissionBrokerServiceDispose.test.ts`

**Interfaces:**

- Produces: `resolveWindowsCuaRuntime(options): Promise<WindowsCuaRuntime>`.
- Compatibility: retain deprecated aliases `resolveWindowsCuaDevRuntime`,
  `WindowsCuaDevRuntime`, and `WindowsCuaDevHelperHost` for existing callers/tests.
- Product options include injectable `resourcesPath`, `arch`, `electronVersion`, and async filesystem/hash dependencies.

- [ ] **Step 1: Extend resolver tests to RED**

  Add packaged-root success and failures for missing resourcesPath, invalid manifest,
  schema/package/platform/arch/Electron mismatch, path traversal, missing file and
  entry/addon hash mismatch. Assert a non-empty but broken `ZCODE_CUA_DEV_ROOT` never
  falls back. Keep the existing source cases.

- [ ] **Step 2: Extend factory tests to RED**

  Change Windows admission expectation: internal feature enabled is sufficient even
  without `ZCODE_CUA_DEV_ROOT`. Inject a packaged runtime into the factory and assert
  no macOS host is constructed. Keep desktop-local/remote guards unchanged.

- [ ] **Step 3: Implement the generalized resolver**

  Source mode preserves existing stable diagnostics. Product mode reads only
  `<resourcesPath>/tools/cua-helper/runtime-manifest.json`, validates exact schema and
  relative paths, hashes both artifacts asynchronously, and returns
  `process.execPath` with token-free `{ ELECTRON_RUN_AS_NODE: "1" }`.

- [ ] **Step 4: Reuse one lifecycle implementation**

  Export `WindowsCuaHelperHost` as the product name and keep the old class alias.
  Update the logger scope/message naming without changing ready PID, health PID,
  restart, termination blocker, token, or named-pipe behavior.

- [ ] **Step 5: Verify Task 3**

  Run:

  ```text
  pnpm exec vitest run packages/services/test/windowsCuaDevRuntime.test.ts packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts packages/services/test/cuaPermissionBrokerServiceDispose.test.ts packages/services/test/windowsCuaDevHelperHost.test.ts
  ```

  Expected: all focused tests pass.

- [ ] **Step 6: Commit**

  Commit: `feat(windows): resolve packaged CUA helper runtime`

### Task 4: Packaging, native signing and afterPack enforcement

**Files:**

- Modify: `packages/desktop/electron-builder.config.js`
- Modify: `packages/desktop/test/runtime-asset-scripts.test.ts`
- Modify: `packages/desktop/scripts/windows-cua-helper-assets.mjs`

**Interfaces:**

- Consumes: staged `bundled-tools/<triplet>/cua-helper`.
- Produces: installed `resources/tools/cua-helper`, signed native files in release builds, and `verifyPackagedWindowsCuaHelper(...)`.

- [ ] **Step 1: Write RED packaging policy tests**

  Assert two explicit extraResources entries (runtime tree and its `node_modules`),
  `win.signExts` contains `.node` and `.dll`, and afterPack calls the packaged Helper
  verifier only for win32.

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `pnpm exec vitest run packages/desktop/test/runtime-asset-scripts.test.ts`

  Expected: FAIL because no Windows Helper packaging policy exists.

- [ ] **Step 3: Implement packaging and verifier**

  Copy the staged tree to `tools/cua-helper`, copy its `node_modules` explicitly,
  add native signing extensions, and run manifest/hash/PE verification in afterPack.
  Local unsigned builds remain allowed; release signing still requires
  `ZCODE_ENABLE_WINDOWS_SIGN=1`.

- [ ] **Step 4: Verify Task 4**

  Run:

  ```text
  pnpm exec vitest run packages/desktop/test/runtime-asset-scripts.test.ts packages/desktop/test/windows-cua-helper-assets.test.ts
  ```

  Expected: all tests pass.

- [ ] **Step 5: Commit**

  Commit: `build(windows): package and sign CUA helper assets`

### Task 5: Packaged runtime acceptance and final gates

**Files:**

- Create: `packages/services/test/windowsCuaProductHelper.integration.test.ts`
- Modify: `docs/cua/windows-product-runtime.md`
- Modify: `docs/cua/windows-source-development.md`

**Interfaces:**

- Consumes: staged or unpacked `resources/tools/cua-helper`.
- Produces: unattended evidence for Electron addon load, ready/health, named-pipe cleanup and no orphan process.

- [ ] **Step 1: Write the integration test**

  Gate on win32 plus an explicit product-root environment variable. Resolve the
  product manifest, construct `WindowsCuaHelperHost`, start it with the Electron
  executable, assert ready/health PID equality, then stop and prove the named pipe
  rejects a fresh connection within 500 ms.

- [ ] **Step 2: Run RED before wiring the staged root**

  Run the test without the product-root variable and assert it is explicitly skipped;
  run it with an invalid root and confirm failure is a stable runtime resolution error.

- [ ] **Step 3: Build an unpacked Windows product**

  Run:

  ```text
  $env:ZCODE_CUA_DEV_ROOT='C:\Users\dev\zcode-cua'
  $env:ZCODE_SKIP_REMOTE_ASSETS='1'
  pnpm --filter @zcode/desktop build
  pnpm --filter @zcode/desktop exec electron-builder --win --x64 --dir
  ```

  Expected: afterPack verifies `resources/tools/cua-helper`; no signing certificate is
  required for this local acceptance build.

- [ ] **Step 4: Run unattended product acceptance**

  Point the integration test at the unpacked `resources` directory and use the
  unpacked ZCode executable as `process.execPath` injection. Then run the existing
  Windows screen-capture, pointer, clipboard and 30-tool live smokes from
  `C:/Users/dev/zcode-cua`.

  Expected: all booleans true, pipe closed after stop, and no owned Helper child remains.

- [ ] **Step 5: Run repository gates**

  Run:

  ```text
  pnpm exec vitest run packages/services/test/windowsCuaDevRuntime.test.ts packages/services/test/windowsCuaDevHelperHost.test.ts packages/services/test/windowsCuaProductHelper.integration.test.ts packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts packages/services/test/cuaPermissionBrokerServiceDispose.test.ts packages/desktop/test/windows-cua-helper-assets.test.ts packages/desktop/test/runtime-asset-scripts.test.ts
  pnpm typecheck
  pnpm lint
  pnpm test:unit:affected
  ```

  Expected: focused tests/typecheck/lint exit `0`; any unchanged affected-suite failures
  are listed by file and kept separate from CUA results.

- [ ] **Step 6: Update evidence and commit**

  Record exact package path, manifest, Electron/Node/N-API versions, test counts,
  signing limitation of the local build, and remaining HDR/ICC risk.

  Commit: `test(windows): prove packaged CUA helper lifecycle`
