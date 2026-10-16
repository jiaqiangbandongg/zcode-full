# SSH Plugin Archive Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent SSH builtin plugin resource archives created on Windows, macOS, or Linux from extracting non-traversable directories on a POSIX remote.

**Architecture:** Keep the existing local tar writer and deployment flow, but make directory archive modes a target-platform invariant instead of copying the desktop filesystem's `stat.mode`. The tar writer will emit `0755` for every directory while preserving the existing file and symlink behavior. When builtin manifests are inaccessible but the product-owned packages root still exists, the agent deployer repairs owner `rwX` before replacing the old directory.

**Tech Stack:** TypeScript, Node.js filesystem APIs, ustar/gzip archive helper, Vitest.

## Global Constraints

- Update the existing SSH plugin sync spec before production code.
- The fix applies to `packages/server/src/remote/localTarGz.ts`, which is shared by production local-download-upload and development SSH asset upload.
- Directory archive entries must use POSIX `0755` on every desktop operating system.
- Existing broken `~/.zcode/server/agents/glm/packages` directories must be repaired automatically before replacement.
- Permission repair is limited to the product-owned builtin packages directory; do not touch `~/.zcode/plugins`.
- Do not change inline plugin archive extraction or remote-download artifact extraction in this fix.
- Add the bug cause as a Chinese production-code comment.
- Run targeted tests, `pnpm typecheck`, and `pnpm lint` before committing.

---

### Task 1: Canonical Remote Asset Directory Modes

**Files:**
- Modify: `packages/server/test/localTarGz.test.ts`
- Modify: `packages/server/src/remote/localTarGz.ts`
- Modify: `packages/server/test/remoteDeploy.test.ts`
- Modify: `packages/server/src/remote/zcodeAgentDeploy.ts`

**Interfaces:**
- Consumes: `createTarGzArchive(archivePath, entries)` and the existing ustar header format.
- Produces: tar directory headers whose mode field is always `0o755`.

- [ ] **Step 1: Write the failing regression test**

Create a source directory with restrictive host permissions, archive it with the real `createTarGzArchive`, parse the generated tar headers, and assert every directory entry has mode `0o755`.

- [ ] **Step 2: Run the regression test and verify RED**

Run: `pnpm vitest run packages/server/test/localTarGz.test.ts`

Expected: the new assertion fails because the current writer copies `sourceStat.mode` into directory headers.

- [ ] **Step 3: Implement the minimal fix**

Change only the directory branch of `appendTarEntry` to pass `0o755` to `createTarHeader`. Add a Chinese comment explaining that Windows directory `stat.mode` lacks portable execute-bit semantics and can create remote `0644` directories after umask processing.

- [ ] **Step 4: Write the failing migration regression**

Add a deploy regression where the packages root exists but a required builtin manifest is inaccessible. Assert that deployment executes `command chmod -R u+rwX` for only `~/.zcode/server/agents/glm/packages`.

- [ ] **Step 5: Run the migration regression and verify RED**

Run: `pnpm vitest run packages/server/test/remoteDeploy.test.ts`

Expected: the new assertion fails because deployment currently reaches resource replacement without repairing the old packages directory.

- [ ] **Step 6: Implement the minimal migration repair**

When required builtin manifests are missing and the packages root exists, execute `command chmod -R u+rwX` for that product-owned directory before normal deployment continues. Add a Chinese comment explaining that this migrates directories damaged by the previous cross-platform tar mode bug.

- [ ] **Step 7: Verify GREEN and regression scope**

Run:

```bash
pnpm vitest run packages/server/test/localTarGz.test.ts packages/server/test/remoteAssetInstaller.test.ts packages/server/test/remoteDeploy.test.ts
pnpm typecheck
pnpm lint
```

Expected: targeted tests and typecheck pass; lint reports no errors.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-07-06-remote-plugin-sync-design.md \
  docs/superpowers/plans/2026-07-10-ssh-plugin-archive-permissions.md \
  packages/server/src/remote/localTarGz.ts \
  packages/server/test/localTarGz.test.ts \
  packages/server/src/remote/zcodeAgentDeploy.ts \
  packages/server/test/remoteDeploy.test.ts
git commit -m "fix(remote): normalize uploaded archive directory modes"
```
