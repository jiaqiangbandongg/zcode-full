# Windows CUA Tool Call and App Launch Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development while executing every behavior change and superpowers:verification-before-completion before handoff.

**Goal:** Eliminate official CUA underscore-name registry misses and make Windows packaged-app launch resolve by exact AUMID evidence in the local source development runtime.

**Architecture:** Keep `mcp__computer-use__*` as the only provider-visible contract and add runtime-only aliases after the existing official-authority gate. Keep Win32 executable launch unchanged; add a separate native `IApplicationActivationManager` plus `PKEY_AppUserModel_ID` identity path for packaged apps.

**Tech Stack:** TypeScript 5.9, Vitest 4, Node 24, N-API/node-addon-api 7, C++17, Windows UI Automation, Win32 COM/Shell APIs, pnpm 10.

## Global Constraints

- Update specs before implementation.
- Work only in `C:\Users\dev\z-code` and `C:\Users\dev\zcode-cua`.
- Do not modify SSH, WSL, Docker, remote workspace, mobile `/remote`, or replayable paths.
- Do not rename the canonical official server or change the 30-tool manifest.
- Never globally normalize hyphens and underscores.
- Never resolve a Windows app by localized title, basename, active state, or enumeration order.
- Preserve existing Win32 full-executable identity validation.
- Add Chinese root-cause comments at both bug-fix sites.
- Run `pnpm typecheck` and `pnpm lint` in both repositories.
- Commit each repository with Conventional Commits.

## Task 1: Lock the official-CUA alias contract

**Files:**

- Modify: `apps/zcode-cli/packages/core/tests/mcp-tool-bridge.test.ts`
- Modify or add focused executor tests under `apps/zcode-cli/packages/core/tests/`
- Modify: `apps/zcode-cli/packages/core/src/mcp/index.ts`

- [ ] Add RED tests for official trusted alias lookup and canonical-only contract projection.
- [ ] Add RED tests proving a third-party descriptor receives no alias.
- [ ] Add RED integration coverage proving alias calls enter permission/hooks/events/MCP dispatch under the canonical name.
- [ ] Implement a single official-CUA server-segment alias on the `ToolEntry`.
- [ ] Reject alias collisions instead of overwriting a canonical tool.
- [ ] Run the focused core tests.

## Task 2: Add native AUMID identity primitives

**Files:**

- Modify: `C:\Users\dev\zcode-cua\src\native\ax_win.cc`
- Modify: `C:\Users\dev\zcode-cua\src\native\types.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\nativeAxSource.ts`
- Modify: `C:\Users\dev\zcode-cua\binding.gyp`
- Add or modify focused native ABI tests under `C:\Users\dev\zcode-cua\test\native\`

- [ ] Add RED source/ABI tests for `activateApplicationByAumid` and `applicationInfoByAumid`.
- [ ] Implement exact `PKEY_AppUserModel_ID` lookup with visible HWND enumeration and PID deduplication.
- [ ] Implement `IApplicationActivationManager` activation without shell command construction.
- [ ] Export the two additive Windows-only ABI methods and update TypeScript declarations.
- [ ] Rebuild the native addon and run focused ABI tests.

## Task 3: Wire the Windows AUMID launch branch

**Files:**

- Modify: `C:\Users\dev\zcode-cua\src\broker\server\windowsSystemSurface.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\nodeSystemSurface.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\helperMain.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\axReadOnly.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\electronAppHelpers.ts`
- Modify: `C:\Users\dev\zcode-cua\src\broker\server\electronNativeBackend.ts`
- Modify focused tests under `C:\Users\dev\zcode-cua\test\`

- [ ] Add RED system-surface tests for native AUMID activation and invalid combinations.
- [ ] Add RED resolver/backend tests for existing unique app, post-activation polling, zero candidates, and multiple candidates.
- [ ] Inject the loaded addon into the Windows system surface.
- [ ] Add the exact AUMID lookup branch without weakening Win32 executable identity.
- [ ] Run focused launch and resolver tests.

## Task 4: Align instructions and local development evidence

**Files:**

- Modify: `C:\Users\dev\zcode-cua\plugin\skills\computer-use\SKILL.md`
- Modify: `apps/zcode-cli/packages/zcode-cua-plugin/skills/computer-use/SKILL.md`
- Modify: `C:\Users\dev\zcode-cua\docs\platforms.md`
- Modify: `docs/cua/windows-source-development.md`

- [ ] State that Windows packaged apps accept AUMID input and subsequent actions should use the returned PID.
- [ ] State that Win32 names should be executable names such as `notepad.exe`.
- [ ] Remove any claim that `ApplicationFrameHost.exe` is a packaged-app identity.
- [ ] Run plugin sync/manifest regression tests.

## Task 5: Verify, commit, and leave source dev ready

- [ ] Run both repositories' focused tests.
- [ ] Run `pnpm typecheck` and `pnpm lint` in both repositories.
- [ ] Run `pnpm test` in `zcode-cua`; record any pre-existing unrelated failures precisely.
- [ ] Run the Windows native build.
- [ ] Start or refresh the source desktop dev runtime without SSH/WSL/Docker.
- [ ] Run an exact Calculator AUMID broker smoke and inspect runtime logs.
- [ ] Commit `zcode-cua` and `z-code` with Conventional Commits.
- [ ] Leave the dev runtime running for user testing.
