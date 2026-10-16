# Bash Resume Git Bash Migration Reminder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Windows legacy 会话在 resume 后实际使用 Git Bash 执行 Bash tool，但模型仍沿用历史 CMD 语法并写出 `nul` 文件的问题。

**Architecture:** 保持现有 session-start shell snapshot 契约不变：shell 设置变更仍只对新 session 生效。只在 cold resume 发现旧会话没有可用 shell snapshot、最终由当前 auto Git Bash 接管执行时，通过现有 `shell_environment_change` provider-visible attachment 插入一次语法迁移提醒。实现集中在 runtime shell owner，不改 executor、protocol schema 或设置 UI。

**Tech Stack:** TypeScript, Vitest, `@zcode/core` runtime, existing `MessageHistory.addAttachment()`, existing `shell_environment_change` system reminder source.

## Global Constraints

- 不新增 shell 热更新语义；同一 session 内切换 shell 设置仍不影响当前 session。
- 不新增 protocol 字段、不新增 setting 字段、不改 Bash executor shell resolve 顺序。
- 不新增新的 system reminder source；复用现有 `shell_environment_change`，避免 provider projection / hydrate / MCS 分类额外迁移面。
- reminder 只针对 legacy/no-usable snapshot resume 后由 `source: "auto-detected"` 且 `dialect: "git-bash"` 的 selection 接管执行。
- reminder 文案只说明未来 Bash command 当前会使用 Git Bash 执行，不针对单个 badcase 做命令写法教学。
- reminder 必须幂等；同一 session 历史中已有 `shell_environment_change` attachment 时不重复插入。
- 继续保留现有 display drift 提醒能力，但文案从 “changed by the user” 改为 resume 场景中性的描述。
- 注释保持中文，说明线上问题根因和为什么只在 resume/migration 场景插提醒。

---

## File Structure

- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/shell-environment.ts`
  - 负责 shell resume notice 的纯判定和文案构造。
  - 新增 `ShellEnvironmentResumeNoticeKind`，把 “display drift” 和 “Windows auto Git Bash migration” 收敛成一个决策函数。

- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts`
  - 保持 runtime shell owner 职责。
  - 将 `announceSessionShellEnvironmentDriftAfterResume()` 重构为 `announceSessionShellEnvironmentNoticeAfterResume()`。
  - 调用 `shell-environment.ts` 的判定和文案函数，并在插入前检查已有 `shell_environment_change` attachment。

- Modify: `apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts`
  - 覆盖 legacy Windows auto Git Bash migration reminder。
  - 覆盖 reminder 幂等。
  - 更新现有 drift/stale shell snapshot 测试文案。

- Modify: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`
  - 更新旧文案反向断言，确保新 session 初始化 Git Bash 时不会误插 migration/drift reminder。

- Modify: `docs/runtime-tools/bash-effective-shell-snapshot.md`
  - 更新 resume 语义说明：legacy/no usable snapshot + auto Git Bash 会插一次语法迁移提醒。
  - 明确这不是 shell hot update。

---

### Task 1: 用测试锁定 legacy Windows auto Git Bash migration reminder

**Files:**
- Modify: `apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts`

**Interfaces:**
- Consumes:
  - `AgentRuntime.resumeFromStore(): Promise<ResumeSessionResult>`
  - `AgentRuntime.executeTurn(input: string): Promise<unknown>`
  - `providerMessagesToText(messages: readonly ModelInputMessage[]): string`
  - existing test helpers `createRecordingSessionStore()`, `createTestSessionEventStore()`
- Produces:
  - 一个失败测试，证明 legacy session resume 后 auto Git Bash 会产生 provider-visible shell reminder。
  - 一个失败测试，证明重复 resume 不会重复插入同一类 reminder。

- [ ] **Step 1: 在 `runtime-persistence.test.ts` 的 Bash shell persistence 用例附近添加 failing test**

Add this test after `announces legacy cold-resume Bash shell drift when no shell snapshot exists`:

```ts
  it("announces Windows Git Bash syntax migration for legacy cold-resume sessions", async () => {
    const sessionId = createSessionId("runtime-persistence-windows-git-bash-migration");
    const store = createRecordingSessionStore();
    const workingDirectory = "/tmp/zcode-runtime-windows-git-bash-migration";
    const firstRuntime = new AgentRuntime(
      sessionId,
      {
        currentDate: "2026-06-26",
        envInfo: {
          cwd: workingDirectory,
          platform: "win32",
          shell: "CMD",
          osVersion: "Windows 11",
          nodeVersion: "v24.14.0",
        },
        workingDirectory,
      },
      {
        eventStore: createTestSessionEventStore(),
        modelAdapter: {
          async generateText() {
            return {
              text: "first answer",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never,
        sessionStore: store,
      },
    );
    await firstRuntime.executeTurn("persisted prompt");

    let resumedMessages: ModelInputMessage[] = [];
    const resumedRuntime = new AgentRuntime(
      sessionId,
      {
        bashShellSelection: {
          dialect: "git-bash",
          display: { name: "Git Bash" },
          id: "auto:git-bash",
          label: "Git Bash",
          path: "C:\\Program Files\\Git\\bin\\bash.exe",
          source: "auto-detected",
        },
        currentDate: "2026-06-26",
        workingDirectory,
      },
      {
        eventStore: createTestSessionEventStore(),
        modelAdapter: {
          async generateText(request) {
            resumedMessages = request.messages;
            return {
              text: "resumed answer",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never,
        sessionStore: store,
      },
    );

    await resumedRuntime.resumeFromStore();
    await resumedRuntime.executeTurn("resumed prompt");

    const providerText = providerMessagesToText(resumedMessages);
    expect(providerText).toContain("- Shell: CMD");
    expect(providerText).toContain(
      "The Bash tool shell is Git Bash.",
    );
  });
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-persistence.test.ts -t "Windows Git Bash syntax migration"
```

Expected: FAIL because provider text does not contain the new Git Bash migration reminder.

- [ ] **Step 3: Add the idempotence failing test**

Add this test after the migration test:

```ts
  it("does not duplicate the Windows Git Bash migration reminder after repeated resume", async () => {
    const sessionId = createSessionId("runtime-persistence-windows-git-bash-migration-once");
    const store = createRecordingSessionStore();
    const workingDirectory = "/tmp/zcode-runtime-windows-git-bash-migration-once";
    const firstRuntime = new AgentRuntime(
      sessionId,
      {
        currentDate: "2026-06-26",
        envInfo: {
          cwd: workingDirectory,
          platform: "win32",
          shell: "CMD",
          osVersion: "Windows 11",
          nodeVersion: "v24.14.0",
        },
        workingDirectory,
      },
      {
        eventStore: createTestSessionEventStore(),
        modelAdapter: {
          async generateText() {
            return {
              text: "first answer",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never,
        sessionStore: store,
      },
    );
    await firstRuntime.executeTurn("persisted prompt");

    const createResumedRuntime = (capture: (messages: ModelInputMessage[]) => void) =>
      new AgentRuntime(
        sessionId,
        {
          bashShellSelection: {
            dialect: "git-bash",
            display: { name: "Git Bash" },
            id: "auto:git-bash",
            label: "Git Bash",
            path: "C:\\Program Files\\Git\\bin\\bash.exe",
            source: "auto-detected",
          },
          currentDate: "2026-06-26",
          workingDirectory,
        },
        {
          eventStore: createTestSessionEventStore(),
          modelAdapter: {
            async generateText(request) {
              capture(request.messages);
              return {
                text: "resumed answer",
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            },
          } as never,
          sessionStore: store,
        },
      );

    let firstResumeMessages: ModelInputMessage[] = [];
    const firstResume = createResumedRuntime((messages) => {
      firstResumeMessages = messages;
    });
    await firstResume.resumeFromStore();
    await firstResume.executeTurn("first resumed prompt");

    let secondResumeMessages: ModelInputMessage[] = [];
    const secondResume = createResumedRuntime((messages) => {
      secondResumeMessages = messages;
    });
    await secondResume.resumeFromStore();
    await secondResume.executeTurn("second resumed prompt");

    const firstProviderText = providerMessagesToText(firstResumeMessages);
    const secondProviderText = providerMessagesToText(secondResumeMessages);
    const reminder =
      "The Bash tool shell is Git Bash.";
    expect(firstProviderText.match(new RegExp(escapeRegExp(reminder), "g")) ?? []).toHaveLength(1);
    expect(secondProviderText.match(new RegExp(escapeRegExp(reminder), "g")) ?? []).toHaveLength(1);
  });
```

Also add this helper near `providerMessagesToText()`:

```ts
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 4: Run the two new tests and verify they fail**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-persistence.test.ts -t "Git Bash migration"
```

Expected: FAIL because implementation does not yet insert the migration reminder and does not yet have idempotence logic.

---

### Task 2: 重构 shell resume reminder 判定和文案

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/shell-environment.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts`

**Interfaces:**
- Consumes:
  - `BashShellSnapshotRestore["status"]`
  - `ExecutionShellSelection`
  - `runtime.messageHistory.toRuntimeEntries()`
  - `runtime.messageHistory.addAttachment("shell_environment_change", body)`
- Produces:
  - `getShellEnvironmentResumeNoticeKind(options): ShellEnvironmentResumeNoticeKind | undefined`
  - `buildShellEnvironmentResumeNotice(kind, selection): string`
  - `announceSessionShellEnvironmentNoticeAfterResume(runtime, options): void`

- [ ] **Step 1: Replace shell reminder helpers in `shell-environment.ts`**

Change `apps/zcode-cli/packages/core/src/runtime/methods/shell-environment.ts` to this shape:

```ts
import type { ExecutionShellSelection } from "../deps.js";
import type { BashShellSnapshotRestore } from "./bash-shell-snapshot.js";

export type ShellEnvironmentResumeNoticeKind =
  | "display_change"
  | "windows_git_bash_auto_migration";

export function getShellEnvironmentResumeNoticeKind(options: {
  persistedShell: string | undefined;
  restoreStatus: BashShellSnapshotRestore["status"];
  selection: ExecutionShellSelection | undefined;
}): ShellEnvironmentResumeNoticeKind | undefined {
  if (!options.selection || options.restoreStatus === "restored") {
    return undefined;
  }

  if (isWindowsGitBashAutoMigration(options.selection)) {
    return "windows_git_bash_auto_migration";
  }

  return hasShellDisplayChanged(options.persistedShell, options.selection)
    ? "display_change"
    : undefined;
}

export function buildShellEnvironmentResumeNotice(
  kind: ShellEnvironmentResumeNoticeKind,
  selection: ExecutionShellSelection,
): string {
  if (kind === "windows_git_bash_auto_migration") {
    return "The Bash tool shell is Git Bash.";
  }

  return `The Bash tool shell is ${selection.display.name}.`;
}

export function hasShellDisplayChanged(
  previousShell: string | undefined,
  selection: ExecutionShellSelection | undefined,
): selection is ExecutionShellSelection {
  const previousDisplayName = normalizeShellDisplayName(previousShell);
  const nextDisplayName = normalizeShellDisplayName(selection?.display.name);
  return previousDisplayName !== undefined && nextDisplayName !== undefined
    ? previousDisplayName !== nextDisplayName
    : false;
}

function isWindowsGitBashAutoMigration(selection: ExecutionShellSelection): boolean {
  return selection.dialect === "git-bash" && selection.source === "auto-detected";
}

function normalizeShellDisplayName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
```

- [ ] **Step 2: Refactor `session-shell-environment.ts` announce function**

Update imports:

```ts
import {
  buildShellEnvironmentResumeNotice,
  getShellEnvironmentResumeNoticeKind,
} from "./shell-environment.js";
```

Replace `announceSessionShellEnvironmentDriftAfterResume()` with:

```ts
export function announceSessionShellEnvironmentNoticeAfterResume(
  runtime: AgentRuntimeInternal,
  options: {
    persistedEnvInfo: EnvInfo | undefined;
    restore: BashShellSnapshotRestore;
  },
): void {
  const selection = getSessionShellSelection(runtime);
  const noticeKind = getShellEnvironmentResumeNoticeKind({
    persistedShell: options.persistedEnvInfo?.shell,
    restoreStatus: options.restore.status,
    selection,
  });
  if (!selection || !noticeKind || hasShellEnvironmentChangeAttachment(runtime)) {
    return;
  }

  // 修复原因：旧 Windows 会话没有可用 shell snapshot 时，升级后可能由 auto Git Bash
  // 接管 Bash 执行。历史上下文仍可能让模型继续沿用旧 shell 习惯，因此必须在
  // resume 后补一个 provider-visible shell 提醒；可用 snapshot 恢复时不插，避免
  // 破坏“shell 设置变更只对新 session 生效”的契约。
  runtime.messageHistory.addAttachment(
    "shell_environment_change",
    buildShellEnvironmentResumeNotice(noticeKind, selection),
  );
}

function hasShellEnvironmentChangeAttachment(runtime: AgentRuntimeInternal): boolean {
  return runtime.messageHistory
    .toRuntimeEntries()
    .some((entry) => entry.metadata?.source === "shell_environment_change");
}
```

- [ ] **Step 3: Update the resume caller**

In `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts`, replace the import and call:

```ts
import {
  announceSessionShellEnvironmentNoticeAfterResume,
  getSessionShellSelection,
  restoreSessionShellEnvironmentSelectionForResume,
} from "./session-shell-environment.js";
```

And:

```ts
  announceSessionShellEnvironmentNoticeAfterResume(this, {
    persistedEnvInfo,
    restore: shellRestore,
  });
```

- [ ] **Step 4: Run the new tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-persistence.test.ts -t "Git Bash migration"
```

Expected: PASS for the two migration tests.

---

### Task 3: 更新现有 shell drift 测试，保持旧能力但改成中性文案

**Files:**
- Modify: `apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts`
- Modify: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

**Interfaces:**
- Consumes:
  - new `buildShellEnvironmentResumeNotice("display_change", selection)` text:
    `The Bash tool shell is ${selection.display.name}.`
- Produces:
  - Existing legacy display drift behavior remains covered.
  - Existing new-session Git Bash initialization does not accidentally emit a resume reminder.

- [ ] **Step 1: Update missing snapshot drift expectation**

In `runtime-persistence.test.ts`, update:

```ts
expect(providerText).toContain(
  "The Bash tool shell was changed by the user. Future Bash commands will run using CMD.",
);
```

to:

```ts
expect(providerText).toContain(
  "The Bash tool shell is CMD.",
);
```

- [ ] **Step 2: Update stale snapshot drift expectation**

In `runtime-persistence.test.ts`, update:

```ts
expect(providerText).toContain(
  "The Bash tool shell was changed by the user. Future Bash commands will run using zsh.",
);
```

to:

```ts
expect(providerText).toContain(
  "The Bash tool shell is zsh.",
);
```

- [ ] **Step 3: Update runtime trace negative assertion**

In `runtime-trace.test.ts`, replace the old negative assertion:

```ts
expect(requestText).not.toContain(
  "The Bash tool shell was changed by the user. Future Bash commands will run using Git Bash.",
);
```

with:

```ts
expect(requestText).not.toContain(
  "The Bash tool shell is Git Bash.",
);
expect(requestText).not.toContain(
  "The Bash tool shell is Git Bash.",
);
```

- [ ] **Step 4: Run focused shell persistence and trace tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-persistence.test.ts -t "shell"
pnpm --filter @zcode/core exec vitest run tests/runtime-trace.test.ts -t "Shell"
```

Expected: PASS. If `runtime-trace.test.ts -t "Shell"` matches no tests because test names changed, run the whole file:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-trace.test.ts
```

Expected: PASS.

---

### Task 4: 更新文档，明确 legacy Windows Git Bash migration 不是 shell hot update

**Files:**
- Modify: `docs/runtime-tools/bash-effective-shell-snapshot.md`

**Interfaces:**
- Consumes:
  - Existing document sections `核心契约`, `Prompt 与缓存`, `非目标`
- Produces:
  - Updated runtime contract docs that explain the new reminder trigger and non-trigger cases.

- [ ] **Step 1: Update `核心契约` legacy resume bullet**

Replace:

```md
- legacy session 如果没有持久化 selection，或持久化 selection 已失效，只能按当前自动解析逻辑 best-effort 恢复；当历史 `# Environment` 的 Shell 与当前执行 shell 不一致时，必须通过 `shell_environment_change` attachment 告知模型。
```

with:

```md
- legacy session 如果没有持久化 selection，或持久化 selection 已失效，只能按当前自动解析逻辑 best-effort 恢复；当历史 `# Environment` 的 Shell 与当前执行 shell 不一致时，必须通过 `shell_environment_change` attachment 告知模型。Windows legacy session 被当前 auto Git Bash 接管时，即使历史 `# Environment` 没有可靠 Shell 字段，也会插入一次 Git Bash shell 提醒，避免模型继续沿用旧 shell 习惯。
```

- [ ] **Step 2: Update `Prompt 与缓存`**

After:

```md
切换 shell 不会向已有 session 追加 `shell_environment_change` attachment。因为 Bash 执行仍然使用 session-start selection，模型看到的初始 `# Environment` 和真实 Bash 执行环境保持一致。
```

Add:

```md
例外是 legacy/no-usable snapshot 的 cold resume：这类会话没有稳定的 session-start shell selection 可恢复，runtime 只能用当前解析出的 selection 继续执行。若 Windows 上最终由 auto Git Bash 接管，会通过 `shell_environment_change` 插入一次短提醒，告诉模型后续 Bash command 当前使用 Git Bash 执行。这不是同 session 内 shell hot update，也不会读取用户最新设置覆盖已有可用 snapshot。
```

- [ ] **Step 3: Run documentation diff review**

Run:

```bash
git diff -- docs/runtime-tools/bash-effective-shell-snapshot.md
```

Expected: Diff only documents legacy/no-usable snapshot resume reminder behavior and does not claim existing sessions hot update shell.

---

### Task 5: Final verification

**Files:**
- Verify only; no additional modifications expected.

**Interfaces:**
- Consumes:
  - All changes from Tasks 1-4
- Produces:
  - Evidence that runtime behavior, provider-visible reminder projection, and docs are coherent.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-persistence.test.ts -t "shell"
pnpm --filter @zcode/core exec vitest run tests/runtime-trace.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run system reminder source tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/system-reminder-source.test.ts
```

Expected: PASS. This verifies reusing `shell_environment_change` did not break descriptor assumptions.

- [ ] **Step 3: Run package typecheck**

Run:

```bash
pnpm --filter @zcode/core typecheck
```

Expected: PASS.

- [ ] **Step 4: Run repo-required checks before commit**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: PASS. If these are too slow or blocked by unrelated existing workspace changes, capture the exact failure and do not claim full verification.

- [ ] **Step 5: Inspect staged diff**

Run:

```bash
git diff -- apps/zcode-cli/packages/core/src/runtime/methods/shell-environment.ts \
  apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts \
  apps/zcode-cli/packages/core/src/runtime/methods/resume.ts \
  apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts \
  apps/zcode-cli/packages/core/tests/runtime-trace.test.ts \
  docs/runtime-tools/bash-effective-shell-snapshot.md
```

Expected:

- No changes to executor shell resolve order.
- No new protocol/settings fields.
- No new system reminder source.
- Only one resume announcement path exists in `session-shell-environment.ts`.
- Git Bash migration reminder text is limited to legacy/no usable snapshot resume paths.

- [ ] **Step 6: Commit**

Run:

```bash
git add apps/zcode-cli/packages/core/src/runtime/methods/shell-environment.ts \
  apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts \
  apps/zcode-cli/packages/core/src/runtime/methods/resume.ts \
  apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts \
  apps/zcode-cli/packages/core/tests/runtime-trace.test.ts \
  docs/runtime-tools/bash-effective-shell-snapshot.md
git commit -m "fix(cli): remind legacy windows sessions about git bash syntax"
```

Expected: Commit succeeds with only the planned files.

---

## Self-Review

- Spec coverage: The plan covers legacy/no-usable snapshot resume, Windows auto Git Bash migration, idempotence, existing display drift preservation, docs, and verification.
- Placeholder scan: No placeholder markers or open-ended “handle edge cases” steps remain.
- Type consistency: The plan reuses existing `ExecutionShellSelection`, `BashShellSnapshotRestore`, `MessageHistory.addAttachment()`, and existing `shell_environment_change` source. It does not introduce protocol/settings/schema fields.
- Complexity check: The plan intentionally avoids new persistent session entries and avoids adding a second reminder source. Repeated `if` logic is centralized in `getShellEnvironmentResumeNoticeKind()`, leaving `session-shell-environment.ts` as the single runtime owner that decides whether to attach a resume notice.
