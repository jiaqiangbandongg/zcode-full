# Bash Effective Shell Snapshot Implementation Plan

> Superseded by `docs/superpowers/plans/2026-06-23-session-shell-environment-owner.md`.
> This document records the original shell snapshot implementation plan; the current refactor plan centralizes lifecycle ownership in `session-shell-environment.ts`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify Bash tool shell resolution, provider-visible environment text, Explore subagent execution, and mid-conversation shell-change notifications around one effective Bash shell snapshot.

**Architecture:** Introduce a session-scoped Effective Bash Shell descriptor that is resolved once at session create/resume and reused by context assembly, Bash execution, and Explore subagents. Runtime shell changes update the execution descriptor immediately and append a provider-visible mid-conversation system notice instead of rewriting the initial `# Environment` system context.

**Tech Stack:** TypeScript, Vitest, `@zcode/contracts`, `@zcode/core`, `@zcode/adapters`, ZCode Protocol session runtime.

## Global Constraints

- Do not rewrite historical `# Environment` messages for active-session shell changes.
- Session-start `EnvInfo.shell` represents the effective Bash shell snapshot at session create/resume time.
- Active-session shell changes are provider-visible through a mid-conversation system attachment source, not by context-prefix replacement.
- Bash execution, `EnvInfo.shell`, Explore prompt, and Explore child runtime must consume the same effective shell descriptor.
- Keep the intended Bash semantics: Bash tool execution is bash/zsh/Git Bash/CMD semantics, not raw `$SHELL` echo semantics.
- Keep existing fallback behavior when no preferred shell is found; this refactor must not turn a previously executable environment into an immediate spawn error.
- Do not expose absolute shell paths in provider-visible text unless a future product decision explicitly requires it.
- Preserve remote/local settings behavior as currently implemented; this plan does not redesign remote-scoped settings.
- Run focused tests first, then `pnpm typecheck` and `pnpm lint` before completion.

---

## Problem Summary

Current Bash shell state has multiple sources of truth:

- Prompt-visible `EnvInfo.shell` is detected from `SHELL ?? ComSpec ?? COMSPEC` in `apps/zcode-cli/packages/adapters/src/context/index.ts`.
- Bash execution resolves shell later in `apps/zcode-cli/packages/adapters/src/exec/index.ts` via `shellProfile: "posix-bash"` and optional `bashShellOverride`.
- Explore child runtime inherits parent `envInfo` but does not explicitly inherit `bashShellOverride`.
- Runtime `updateConfig({ bashShellOverride })` changes future execution without notifying the model.
- Refreshing `# Environment` on shell change would cause a provider-visible system prompt mutation and likely prompt-cache loss.

The intended end state is:

- Initial context says what the effective Bash shell was when the session started.
- If the shell changes during the session, the conversation receives a new mid-conversation system notice.
- Future Bash executions use the same descriptor that was announced.

## File Structure

- Modify: `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts`
  - Owns the cross-layer type for effective Bash shell selection.
- Modify: `apps/zcode-cli/packages/contracts/src/interfaces/context-source.port.ts`
  - Allows context source resolution to receive a shell display override without asking the context adapter to duplicate shell resolver logic.
- Modify: `apps/zcode-cli/packages/adapters/src/exec/bash-shell-provider.ts`
  - Becomes the single shell resolver and provider factory for Bash shell execution and display metadata.
- Modify: `apps/zcode-cli/packages/adapters/src/exec/index.ts`
  - Consumes the effective descriptor instead of independently resolving display/execution state.
- Modify: `apps/zcode-cli/packages/adapters/src/context/index.ts`
  - Uses request-provided effective shell display when present; otherwise keeps legacy env detection fallback.
- Modify: `apps/zcode-cli/packages/core/src/system-reminder/source.ts`
  - Adds the shell-change source for provider-visible mid-conversation system projection.
- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
  - Stores the session effective Bash shell descriptor in runtime config.
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/context.ts`
  - Resolves the initial effective shell snapshot before building the initial context.
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`
  - Replaces silent shell override updates with an explicit runtime shell update path.
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
  - Passes the effective Bash shell descriptor into Explore child runtime.
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
  - Passes the effective shell descriptor to Bash execution.
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/types.ts`, `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`, `apps/zcode-cli/packages/core/src/tool/executor/impl.ts`
  - Thread the descriptor through the execution boundary.
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`
  - Converts protocol shell selection changes into runtime shell selection updates and model notices.
- Tests:
  - `apps/zcode-cli/packages/adapters/tests/exec.test.ts`
  - `apps/zcode-cli/packages/adapters/tests/fs-context.test.ts`
  - `apps/zcode-cli/packages/core/tests/system-reminder-source.test.ts`
  - `apps/zcode-cli/packages/core/tests/context-builder.test.ts`
  - `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`
  - `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`
  - `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`
  - `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`
  - `apps/zcode-cli/packages/bootstrap/tests/session-persistence.test.ts`

---

### Task 1: Define Effective Bash Shell Descriptor

**Files:**
- Modify: `apps/zcode-cli/packages/contracts/src/interfaces/execution.port.ts`

**Interfaces:**
- Produces: `ExecutionShellSelection`, `ExecutionShellSource`, `ExecutionShellDisplay`
- Consumes: existing `ExecutionShellDialect`

- [ ] **Step 1: Add the descriptor types**

Add these types next to `ExecutionShellDialect`:

```ts
export type ExecutionShellSource = "auto-detected" | "user-config" | "legacy-fallback";

export interface ExecutionShellDisplay {
  /**
   * Stable provider-visible shell name. Never include absolute paths here.
   * Examples: "bash", "zsh", "Git Bash", "CMD", "system shell".
   */
  name: string;
}

export interface ExecutionShellSelection {
  /** Stable id from UI/settings or resolver-generated auto id. */
  id?: string;
  /** Human-readable diagnostic label. This can include more detail than display.name. */
  label?: string;
  /** Executable path when ZCode resolved a concrete shell. Omitted for legacy shell fallback. */
  path?: string;
  /** Shell syntax and cwd capture wrapper semantics. */
  dialect: ExecutionShellDialect | "legacy-shell";
  /** Why this selection exists. */
  source: ExecutionShellSource;
  /** Provider-visible stable name. */
  display: ExecutionShellDisplay;
}
```

- [ ] **Step 2: Keep compatibility while removing semantic ambiguity**

Replace `ExecutionShellOverride` with a compatibility alias:

```ts
export type ExecutionShellOverride = ExecutionShellSelection;
```

Then update the comment above `ExecutionCommand.shellOverride` so it reads:

```ts
/**
 * ZCode runtime-provided Bash shell selection. Current consumers must only use
 * this when shellProfile === "posix-bash"; generic shell execution must ignore it.
 */
shellOverride?: ExecutionShellSelection;
```

- [ ] **Step 3: Run contract typecheck**

Run:

```bash
pnpm --filter @zcode/contracts typecheck
```

Expected: typecheck passes or fails only at downstream call sites that still expect `source: "user-config"` only. Those downstream failures are addressed in later tasks.

---

### Task 2: Refactor Bash Shell Resolver Into One Data Source

**Files:**
- Modify: `apps/zcode-cli/packages/adapters/src/exec/bash-shell-provider.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/exec/index.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/exec.test.ts`

**Interfaces:**
- Consumes: `ExecutionShellSelection`
- Produces: `resolveEffectiveBashShellSelection(options)`, `createShellProviderCommand(...)` continues to consume the chosen provider

- [ ] **Step 1: Add resolver result shape**

In `bash-shell-provider.ts`, add:

```ts
export interface EffectiveBashShellResolution {
  selection: ExecutionShellSelection;
  provider?: BashShellProvider;
}
```

- [ ] **Step 2: Add a single resolver entrypoint**

Add a new exported function:

```ts
export function resolveEffectiveBashShellSelection(options: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform | string;
  exists?: ExecutableCheck;
  override?: ExecutionShellSelection;
}): EffectiveBashShellResolution {
  if (options.platform === "win32") {
    return resolveEffectiveWindowsBashShellSelection(options);
  }
  return resolveEffectivePosixBashShellSelection(options);
}
```

Implementation rules:

- Windows user `git-bash` override with executable path returns `source: "user-config"`, `dialect: "git-bash"`, `display.name: "Git Bash"`, and a Git Bash provider.
- Windows user `cmd` override returns `source: "user-config"`, `dialect: "cmd"`, `display.name: "CMD"`, and a CMD provider.
- Windows auto Git Bash returns `source: "auto-detected"`, `dialect: "git-bash"`, `display.name: "Git Bash"`, and a Git Bash provider.
- Windows with no Git Bash returns `source: "legacy-fallback"`, `dialect: "legacy-shell"`, `display.name: "system shell"`, and no provider so the existing generic shell fallback remains available.
- POSIX bash/zsh returns `source: "auto-detected"`, `dialect: "posix"`, `display.name: "bash"` or `"zsh"`, and a provider.
- POSIX with no bash/zsh returns `source: "legacy-fallback"`, `dialect: "legacy-shell"`, `display.name: "system shell"`, and no provider.

- [ ] **Step 3: Make execution consume the descriptor**

In `apps/zcode-cli/packages/adapters/src/exec/index.ts`, replace the separate Windows/POSIX resolver branches with:

```ts
if (command.shellProfile === "posix-bash") {
  const resolution = resolveEffectiveBashShellSelection({
    env,
    exists: options.exists,
    override: command.shellOverride,
    platform,
  });
  if (resolution.provider) {
    return createShellProviderCommand(resolution.provider, command.command);
  }
}
```

Leave the existing generic shell fallback unchanged after this block.

- [ ] **Step 4: Add resolver tests**

In `apps/zcode-cli/packages/adapters/tests/exec.test.ts`, add tests for:

- POSIX `SHELL=/bin/fish` with `/usr/bin/zsh` executable resolves `display.name === "zsh"` and uses `/usr/bin/zsh`.
- POSIX no bash/zsh resolves `legacy-fallback` and execution still falls through to generic shell.
- Windows auto Git Bash resolves `display.name === "Git Bash"`.
- Windows explicit CMD override resolves `display.name === "CMD"` even when Git Bash also exists.

- [ ] **Step 5: Run adapter tests**

Run:

```bash
pnpm --filter @zcode/adapters exec vitest run tests/exec.test.ts
```

Expected: all adapter exec tests pass.

---

### Task 3: Feed Session Shell Snapshot Into Context

**Files:**
- Modify: `apps/zcode-cli/packages/contracts/src/interfaces/context-source.port.ts`
- Modify: `apps/zcode-cli/packages/adapters/src/context/index.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/context.ts`
- Test: `apps/zcode-cli/packages/adapters/tests/fs-context.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

**Interfaces:**
- Consumes: `ExecutionShellSelection.display.name`
- Produces: stable `EnvInfo.shell` from the effective snapshot

- [ ] **Step 1: Extend context source request**

In `ContextSourceRequest`, add:

```ts
effectiveShellDisplayName?: string;
```

- [ ] **Step 2: Use request display name in context detection**

In `NodeContextSourceAdapter.detectEnvInfo`, accept an optional display name parameter:

```ts
private async detectEnvInfo(
  workingDirectory: string,
  effectiveShellDisplayName?: string,
): Promise<EnvInfo> {
  const shellPath = this.env.SHELL ?? this.env.ComSpec ?? this.env.COMSPEC ?? "";
  const shell = effectiveShellDisplayName ?? (shellPath ? basename(shellPath) : "unknown");
  ...
}
```

Then call:

```ts
const envInfo =
  request.envInfo ??
  (await this.detectEnvInfo(workingDirectory, request.effectiveShellDisplayName));
```

- [ ] **Step 3: Store shell snapshot in runtime config**

In `AgentRuntimeConfig`, add:

```ts
bashShellSelection?: ExecutionShellSelection | undefined;
```

Keep `bashShellOverride` only as a temporary compatibility field if needed by existing tests; new runtime code should read `bashShellSelection`.

- [ ] **Step 4: Pass shell display into context resolution**

In `initializeContext` / context source resolution, pass:

```ts
effectiveShellDisplayName: this.config.bashShellSelection?.display.name,
```

This makes initial `# Environment Shell:` a session-start snapshot.

- [ ] **Step 5: Add context tests**

Add a runtime trace test where:

- process env says `SHELL=/bin/fish`
- runtime config has `bashShellSelection.display.name === "zsh"`
- resolved `contextSourceSnapshot.envInfo.shell` is `"zsh"`

Add an adapter context test where no `effectiveShellDisplayName` is provided and the legacy env-based behavior remains unchanged.

- [ ] **Step 6: Run context tests**

Run:

```bash
pnpm --filter @zcode/adapters exec vitest run tests/fs-context.test.ts
pnpm --filter @zcode/core exec vitest run tests/runtime-trace.test.ts
```

Expected: new tests pass and existing context behavior remains covered.

---

### Task 4: Add Shell Change Mid-Conversation System Source

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/system-reminder/source.ts`
- Test: `apps/zcode-cli/packages/core/tests/system-reminder-source.test.ts`
- Test: `apps/zcode-cli/packages/core/src/runtime/helpers/provider-request-messages.ts` existing tests or nearest provider-request helper test file

**Interfaces:**
- Produces: `shell_environment_change` source
- Consumes: existing mid-conversation system projection

- [ ] **Step 1: Add source**

Add `"shell_environment_change"` to `SYSTEM_REMINDER_PERSISTED_SOURCES`.

Add descriptor:

```ts
shell_environment_change: descriptor(
  "mid_turn_event",
  "mid_turn_event",
  true,
  "sr.shell_environment_change",
),
```

- [ ] **Step 2: Confirm it is mid-conversation**

Do not add it to `NON_MID_CONVERSATION_SYSTEM_SOURCES`.

This lets provider projection create a true mid-conversation `role: "system"` message when the provider-visible ordering is legal, and fallback to `<system-reminder>` user text only when needed.

- [ ] **Step 3: Add source tests**

In `system-reminder-source.test.ts`, assert:

```ts
expect(isMidConversationSystemSource("shell_environment_change")).toBe(true);
expect(getSystemReminderDescriptor("shell_environment_change")).toMatchObject({
  channel: "mid_turn_event",
  lifecycle: "mid_turn_event",
  isMeta: true,
  providerVisibility: "provider_visible",
});
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/system-reminder-source.test.ts
```

Expected: source classification passes.

---

### Task 5: Replace Silent Shell Updates With Explicit Runtime Shell Updates

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/internal-methods.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`

**Interfaces:**
- Consumes: `ExecutionShellSelection`
- Produces: runtime method `updateBashShellSelection(selection, options)`

- [ ] **Step 1: Add runtime method**

Add an internal/runtime method with this shape:

```ts
updateBashShellSelection(
  selection: ExecutionShellSelection | undefined,
  options?: { notifyModel?: boolean },
): void;
```

- [ ] **Step 2: Implement update semantics**

Implementation logic:

```ts
const previousKey = shellSelectionCacheKey(this.config.bashShellSelection);
const nextKey = shellSelectionCacheKey(selection);
this.config.bashShellSelection = selection;
this.config.bashShellOverride = selection;

if (options?.notifyModel === true && previousKey !== nextKey && selection) {
  this.messageHistory.addAttachment(
    "shell_environment_change",
    buildShellEnvironmentChangeReminder(selection),
  );
}
```

`shellSelectionCacheKey` should use stable fields:

```ts
function shellSelectionCacheKey(selection: ExecutionShellSelection | undefined): string {
  if (!selection) return "auto:none";
  return [
    selection.source,
    selection.dialect,
    selection.display.name,
    selection.path ?? "",
  ].join("\0");
}
```

`buildShellEnvironmentChangeReminder` should not include absolute paths:

```ts
function buildShellEnvironmentChangeReminder(selection: ExecutionShellSelection): string {
  return `The Bash tool shell was changed by the user. Future Bash commands will run using ${selection.display.name}.`;
}
```

- [ ] **Step 3: Keep `updateConfig` from refreshing context**

Remove direct `bashShellOverride` mutation from generic `updateConfig` callers where possible. If backward compatibility requires keeping the field, make it delegate to `updateBashShellSelection(patch.bashShellOverride, { notifyModel: false })`.

Do not call `refreshContextModelSnapshot()` from shell updates.

- [ ] **Step 4: Update protocol shell change path**

In `applyIntegratedTerminalShellToRecord`, call:

```ts
record.app.runtime.updateBashShellSelection(
  integratedTerminalShellToExecutionSelection(selection),
  { notifyModel: true },
);
```

For session create/resume, call the same runtime path with `{ notifyModel: false }` through initial runtime config.

- [ ] **Step 5: Add update tests**

Add tests that prove:

- Changing shell appends exactly one `shell_environment_change` attachment.
- Reapplying the same shell does not append another attachment.
- Changing shell does not replace context-prefix messages.
- Changing shell does not mutate existing `# Environment Shell:` text.

- [ ] **Step 6: Run tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-trace.test.ts
pnpm --filter @zcode/bootstrap exec vitest run tests/zcode-protocol.test.ts
```

Expected: shell update is model-visible through an added mid-conversation system notice and does not refresh the context prefix.

---

### Task 6: Thread Effective Shell Selection Through Bash Execution

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/tool/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/impl.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- Test: `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`

**Interfaces:**
- Consumes: runtime `bashShellSelection`
- Produces: Bash execution request with `command.shellOverride = bashShellSelection`

- [ ] **Step 1: Rename execution dependency getters**

Introduce `getBashShellSelection` next to the current `getBashShellOverride` path:

```ts
getBashShellSelection?: () => ExecutionShellSelection | undefined;
```

Use it first, then fallback to old `getBashShellOverride` while compatibility remains.

- [ ] **Step 2: Update Bash tool execution context**

In Bash tool context types, add:

```ts
bashShellSelection?: ExecutionShellSelection;
```

Keep `bashShellOverride` as a compatibility alias during the migration.

- [ ] **Step 3: Update `createExecutionRequest`**

Use the effective selection:

```ts
const shellSelection = context.bashShellSelection ?? context.bashShellOverride;
...
...(shellSelection ? { shellOverride: shellSelection } : {}),
```

- [ ] **Step 4: Add Bash handler tests**

Add a test that runtime-provided `bashShellSelection` is passed into the execution request.

Add a test that missing `bashShellSelection` keeps current auto-resolution behavior.

- [ ] **Step 5: Run Bash tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/bash-handler.test.ts
```

Expected: Bash handler passes the effective shell selection when present and preserves fallback behavior when absent.

---

### Task 7: Make Explore Inherit Shell Snapshot and Execution Selection

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- Test: `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`

**Interfaces:**
- Consumes: parent runtime `bashShellSelection`
- Produces: child runtime with matching `envInfo.shell` and matching Bash execution selection

- [ ] **Step 1: Use parent shell display in child env**

When building `childEnvInfo`, prefer:

```ts
const childEnvInfo = {
  ...(this.contextSourceSnapshot?.envInfo ?? this.config.envInfo ?? fallbackEnvInfo),
  ...(this.config.bashShellSelection
    ? { shell: this.config.bashShellSelection.display.name }
    : {}),
};
```

- [ ] **Step 2: Pass selection into child runtime**

In child runtime config, add:

```ts
bashShellSelection: this.config.bashShellSelection,
bashShellOverride: this.config.bashShellSelection ?? this.config.bashShellOverride,
```

- [ ] **Step 3: Add Explore tests**

Add a test where parent has `bashShellSelection.display.name === "Git Bash"` and Explore prompt contains:

```text
Shell: Git Bash
```

Add a test that child runtime Bash execution receives the same selection.

- [ ] **Step 4: Run Explore tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/subagent-explore.test.ts
```

Expected: Explore prompt and child Bash execution no longer diverge from the parent session.

---

### Task 8: Preserve Session Resume and History Semantics

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/message-persistence.ts`
- Modify: `apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/session-persistence.test.ts`

**Interfaces:**
- Consumes: persisted `EnvInfo.shell` and `shell_environment_change` attachments
- Produces: resumed sessions that retain the original environment snapshot plus later shell-change notices

- [ ] **Step 1: Keep persisted `EnvInfo.shell` immutable on resume**

Do not recompute the initial `EnvInfo.shell` when persisted context snapshot already exists. The resumed initial snapshot remains what the session started with.

- [ ] **Step 2: Ensure shell change notices hydrate as attachments**

Because `shell_environment_change` is a known persisted system reminder source, existing synthetic attachment hydration should preserve it. Add a test that a persisted shell-change notice hydrates back into `messageHistory.addAttachment("shell_environment_change", ...)`.

- [ ] **Step 3: Add resume tests**

Test this timeline:

1. Session starts with `Shell: Git Bash`.
2. User changes shell to `CMD`; runtime appends `shell_environment_change`.
3. Session persists and resumes.
4. Provider-visible history still contains initial `Shell: Git Bash`.
5. Provider-visible history also contains the later shell change notice for `CMD`.

- [ ] **Step 4: Run persistence tests**

Run:

```bash
pnpm --filter @zcode/bootstrap exec vitest run tests/session-persistence.test.ts
```

Expected: resume keeps chronological truth instead of rewriting the initial environment.

---

### Task 9: Keep Windows Detection Changes Separate and Conservative

**Files:**
- Modify only if product wants this in the same change: `apps/zcode-cli/packages/adapters/src/exec/bash-shell-provider.ts`
- Modify only if product wants this in the same change: `packages/services/src/system/integratedTerminalShells.ts`
- Test only if product wants this in the same change: `apps/zcode-cli/packages/adapters/tests/exec.test.ts`

**Interfaces:**
- Consumes: existing Windows Git Bash candidate resolver
- Produces: optional extra candidate coverage without changing source-of-truth semantics

- [ ] **Step 1: Decide whether to include detection breadth in this refactor**

Recommended decision: keep this out of the first implementation unless current release feedback confirms the missed install path. This keeps the refactor focused on source-of-truth and cache safety.

- [ ] **Step 2: If included, add one low-risk candidate**

Add `%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe` to both runtime resolver and settings enumeration when `LOCALAPPDATA` is present.

- [ ] **Step 3: Test candidate order**

Assert explicit user selection still wins, then fixed Program Files candidates, then PATH-derived candidates, then LocalAppData candidate if the chosen order is adopted.

Run:

```bash
pnpm --filter @zcode/adapters exec vitest run tests/exec.test.ts
```

Expected: existing Git Bash and CMD behavior remains unchanged except the new per-user install path is detectable when present.

---

### Task 10: Documentation and Validation

**Files:**
- Create or update: `docs/runtime-tools/bash-effective-shell-snapshot.md`

**Interfaces:**
- Consumes: final implementation semantics
- Produces: maintainable spec explaining why this is not a patch-on-patch fix

- [ ] **Step 1: Write runtime spec**

Document these rules:

- Initial `# Environment Shell:` is a session-start effective Bash shell snapshot.
- Active-session shell changes do not rewrite the initial environment.
- Active-session shell changes append a mid-conversation system notice.
- Explore inherits the parent effective shell descriptor.
- Execution and provider-visible shell text are derived from the same descriptor.
- Absolute shell paths stay out of provider-visible text.

- [ ] **Step 2: Run focused test suite**

Run:

```bash
pnpm --filter @zcode/adapters exec vitest run tests/exec.test.ts tests/fs-context.test.ts
pnpm --filter @zcode/core exec vitest run tests/system-reminder-source.test.ts tests/context-builder.test.ts tests/runtime-trace.test.ts tests/subagent-explore.test.ts tests/bash-handler.test.ts
pnpm --filter @zcode/bootstrap exec vitest run tests/zcode-protocol.test.ts tests/session-persistence.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 3: Run required repository checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both commands pass.

- [ ] **Step 4: Real-world prompt validation**

Run the existing Bash shell real-world prompt under `docs` or the current `real-world-test-prompt` folder. Validate:

- Windows Git Bash / CMD selection produces expected command behavior.
- mac/linux fish default displays the effective Bash shell, not `fish`.
- Shell switch during a session produces a mid-conversation system notice.
- Explore Bash uses the same shell as the parent.

---

## Acceptance Criteria

- `EnvInfo.shell` in initial context is derived from the effective Bash shell descriptor, not raw `SHELL/ComSpec`.
- Active-session shell changes do not call context refresh and do not replace existing context-prefix messages.
- Active-session shell changes append exactly one provider-visible `shell_environment_change` notice per distinct effective shell change.
- Bash execution consumes the same descriptor announced to the model.
- Explore prompt and Explore child Bash execution consume the parent descriptor.
- Resume preserves chronological truth: initial shell snapshot remains initial, later shell changes remain later notices.
- Existing fallback execution behavior remains available when no preferred shell is found.
- Focused tests, `pnpm typecheck`, and `pnpm lint` pass.
