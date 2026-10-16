# Local Remote Asset Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the desktop client's local system tar dependency from the SSH `local-download-upload` remote asset flow.

**Architecture:** Add a focused Node `.tar.gz` helper under `packages/server/src/remote` and route only local archive extraction/creation through it. Keep remote-download and remote-host extraction behavior unchanged.

**Tech Stack:** TypeScript, Node built-ins (`zlib`, `fs/promises`, `path`), Vitest.

---

### Task 1: Add Regression Tests

**Files:**
- Modify: `packages/server/test/remoteDeploy.test.ts`
- Modify: `packages/server/test/remoteAssetInstaller.test.ts`

- [ ] **Step 1: Write the failing extraction regression**

Add a test that stages CDN component artifacts, calls `ensureRemoteReleaseDirFromCdn()`, and asserts the component file exists in the local cache. Before implementation, this still uses the production code path that spawns system tar.

- [ ] **Step 2: Write the local upload archive regression**

Add a `LocalUploadAssetInstaller.installDirectory()` test that uploads a directory and verifies the generated archive contains the source directory root after extraction through the Node helper.

- [ ] **Step 3: Run targeted tests and verify RED**

Run:

```bash
pnpm vitest run packages/server/test/remoteDeploy.test.ts packages/server/test/remoteAssetInstaller.test.ts
```

Expected before implementation: the new tests fail because the Node archive helper does not exist or the implementation still uses system tar.

### Task 2: Implement Node Archive Helper

**Files:**
- Create: `packages/server/src/remote/localTarGz.ts`

- [ ] **Step 1: Implement `extractTarGzArchive()`**

Use `gunzip` to read a `.tar.gz` archive, parse 512-byte tar headers, create directories/files, and reject unsafe or unsupported entries.

- [ ] **Step 2: Implement `createTarGzArchive()`**

Build deterministic ustar headers for regular files and directories, write archive data padded to 512-byte records, append end blocks, and gzip the result.

- [ ] **Step 3: Add Chinese comments for bug cause**

Document that this avoids relying on Windows `System32\tar.exe`, which can be missing or inaccessible from the desktop host process.

### Task 3: Replace Local Tar Calls

**Files:**
- Modify: `packages/server/src/remote/remoteAssetCache.ts`
- Modify: `packages/server/src/remote/remoteAssetInstaller.ts`
- Modify: `packages/server/test/remoteDeploy.test.ts`

- [ ] **Step 1: Replace local extraction**

Change CDN component extraction from `execFileAsync(tarCommand, ["-xzf", archivePath, "-C", extractRoot])` to `extractTarGzArchive(archivePath, extractRoot)`.

- [ ] **Step 2: Replace local directory archive creation**

Change `LocalUploadAssetInstaller.installDirectory()` from `execFileSync(localTarCommand, ...)` to `createTarGzArchive(localTarPath, [{ sourcePath: localPath, archivePath: basename(localPath) }])`.

- [ ] **Step 3: Replace test fixture archive creation**

Use `createTarGzArchive()` in CDN fixture staging helpers so tests also avoid local system tar.

### Task 4: Verify and Commit

**Files:**
- All touched files

- [ ] **Step 1: Run targeted tests**

```bash
pnpm vitest run packages/server/test/remoteDeploy.test.ts packages/server/test/remoteAssetInstaller.test.ts
```

- [ ] **Step 2: Run required repo checks**

```bash
pnpm typecheck
pnpm lint
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-16-local-remote-asset-archive-design.md docs/superpowers/plans/2026-06-16-local-remote-asset-archive.md packages/server/src/remote/localTarGz.ts packages/server/src/remote/remoteAssetCache.ts packages/server/src/remote/remoteAssetInstaller.ts packages/server/test/remoteDeploy.test.ts packages/server/test/remoteAssetInstaller.test.ts
git commit -m "fix(remote): remove local tar dependency for remote assets"
```
