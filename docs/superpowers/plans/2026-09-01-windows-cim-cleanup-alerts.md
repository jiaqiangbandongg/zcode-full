# Windows CIM Cleanup Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove WMIC from Windows runtime process cleanup and emit cleanup errors only after the final retry fails.

**Architecture:** PowerShell `Get-CimInstance Win32_Process` is the sole Windows process identity backend. A full asynchronous snapshot discovers the owned tree, and a bounded targeted CIM query revalidates identities before force kill. Cleanup retry owns the final alert decision: transient first-attempt errors remain recoverable warnings.

**Tech Stack:** TypeScript, Node.js `child_process.execFile`, Vitest, pnpm.

## Global Constraints

- Supported Windows versions are Windows 10 and later.
- Preserve PID + CreationDate matching and fail-closed behavior for descendants and explicit
  `unverifiedRootOnly` cleanup.
- Never force-kill a bare PID. A Host-owned live `ChildProcess` root handle is the only root-only
  ownership exception and must never rediscover or claim descendants.
- Keep desktop continuous and web-remote replayable lifecycle semantics unchanged.
- No synchronous IO added to the cleanup path.
- Update the Windows cleanup spec when backend behavior changes.

### Task 1: Convert Windows process identity lookup to CIM-only

**Files:**
- Modify: `packages/services/src/process/windowsProcessListAsync.ts`
- Test: `packages/services/test/processTreeTerminator.windows.test.ts`

**Interfaces:**
- Preserve `readWindowsProcessListAsync` and `verifyWindowsProcessIdentityAsync` signatures.
- Remove WMIC-specific parser, timeout, reserve, and fallback branches.

- [ ] **Step 1: Rewrite Windows tests to require direct PowerShell/CIM**

  Replace WMIC setup assertions with PowerShell responses. Add a test that a full snapshot invokes `powershell.exe` and never invokes `wmic.exe`. Add a targeted identity test that directly invokes PowerShell and force-kills only on matching CreationDate.

- [ ] **Step 2: Run the focused Windows test file and verify the new tests fail**

  Run `pnpm exec vitest run packages/services/test/processTreeTerminator.windows.test.ts --reporter=dot`.

  Expected: the new no-WMIC assertions fail because the current implementation still invokes `wmic.exe` first.

- [ ] **Step 3: Implement the minimal CIM-only lookup**

  Make the full snapshot execute the existing PowerShell process-list command directly. Make targeted identity verification execute the existing PID-filtered PowerShell command directly. Keep timeout bounded by the existing cleanup deadline and return `false` on unavailable/timeout/error without sending a force command.

- [ ] **Step 4: Run the focused Windows test file and verify it passes**

  Run the same Vitest command. Expected: all tests in the file pass and `execFileMock` records no `wmic.exe` call.

- [ ] **Step 5: Commit the backend change**

  Run `git add packages/services/src/process/windowsProcessListAsync.ts packages/services/test/processTreeTerminator.windows.test.ts` and commit with `fix(services): use cim for windows process cleanup`.

### Task 2: Emit cleanup error only after final retry

**Files:**
- Modify: `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`
- Test: `packages/services/test/zcodeAgentProcessManager.test.ts`

**Interfaces:**
- Preserve public `disposeWorkspace` and `disposeAllAndWait` behavior.
- Keep the final rejected error unchanged for callers.

- [ ] **Step 1: Add a failing retry-alert test**

  Exercise a managed process whose first cleanup attempt rejects and whose retry resolves. Assert that the logger receives a recoverable warning, no cleanup error is emitted, and the cleanup promise resolves. Add a second case where both attempts reject and assert exactly one final cleanup error.

- [ ] **Step 2: Run the focused manager tests and verify they fail**

  Run `pnpm exec vitest run packages/services/test/zcodeAgentProcessManager.test.ts --reporter=dot`.

  Expected: the first-attempt-successful-retry case fails because the current code emits `errorLog` before retry.

- [ ] **Step 3: Move error logging to the final failure boundary**

  Keep the first error local to `cleanupManagedProcessWithRetry`, log it at recoverable severity, retry once, and call `errorLog` only in the catch for the second failure. Ensure the returned promise remains handled by existing shutdown callers.

- [ ] **Step 4: Run the focused manager tests and verify they pass**

  Run the same Vitest command. Expected: all manager tests pass, with one final error only when both attempts fail.

- [ ] **Step 5: Commit the retry alert change**

  Run `git add packages/services/src/zcode-agent/zcodeAgentProcessManager.ts packages/services/test/zcodeAgentProcessManager.test.ts` and commit with `fix(services): report process cleanup errors after retry`.

### Task 3: Update documentation and run verification

**Files:**
- Modify: `docs/desktop/agent-shutdown-latency.md`
- Modify: `docs/windows-agent-process-cleanup-state-machine.md`

- [ ] **Step 1: Replace WMIC-primary wording with CIM-only wording**

  Document the cached capability, one full snapshot, targeted pre-force recheck, fail-closed behavior
  for unverified identities, and the root-only managed `ChildProcess` handle exception.

- [ ] **Step 2: Run affected tests**

  Run `pnpm exec vitest run packages/services/test/processTreeTerminator.windows.test.ts packages/services/test/zcodeAgentProcessManager.test.ts --reporter=dot`.

- [ ] **Step 3: Run mandatory checks**

  Run `pnpm typecheck` and `pnpm lint`. Record any pre-existing unrelated typecheck failure without weakening cleanup behavior.

- [ ] **Step 4: Inspect diff and commit documentation**

  Run `git diff --check` and `git status --short`, then commit with `docs(services): document cim-only process cleanup`.
