# Session Shell Environment Owner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Bash shell 的 session-start 快照、provider-visible Shell 展示、Bash executor selection、resume 恢复和 Explore 继承收敛到一个 runtime owner，消除当前多层各自维护 shell 状态的复杂度。

**Architecture:** 保留现有 `ExecutionShellSelection` / `resolveEffectiveBashShellSelection()` 的解析能力，但新增一个 core runtime owner：`session-shell-environment.ts`。所有 runtime 内部 shell 状态读写、EnvInfo shell patch、snapshot persist/restore 都通过这个 owner；pre-conversation context rebuild 抽到无环的 shared helper，owner 只调用 helper，不反向依赖 `config.ts` / `context.ts`。bootstrap/protocol 只负责提供“当前候选 selection”，不再维护额外 prepared 状态。

**Tech Stack:** TypeScript, Vitest, `@zcode/contracts`, `@zcode/adapters`, `@zcode/core`, `@zcode/bootstrap`, ZCode Protocol.

## Global Constraints

- 目标语义：Bash shell 设置只影响新 session；已有 session 使用创建时的 session shell snapshot。
- deferred draft 预热阶段不读取用户 shell setting；首条真实用户执行边界前读取一次候选 selection。
- Bash executor 使用的 shell 和 provider-visible `# Environment` 里的 `Shell` 必须来自同一个 session shell environment。
- resume 优先恢复持久化的 session shell snapshot；snapshot 失效时使用当前候选 selection fallback，并通过 provider-visible reminder 说明 drift。
- macOS / Linux shell 解析保持现状：优先 zsh/bash；fish 等非 Bash-compatible shell 不作为 Bash tool shell；解析失败走 legacy fallback。
- Windows shell 解析保持现状：用户显式选择优先；auto 优先 Git Bash；找不到时走 legacy cmd/ComSpec fallback。
- provider-visible 文本禁止展示绝对 shell path，只展示 `display.name`。
- 不在本计划里重做 remote-scoped settings；UI setting 仍是现有 global setting 行为。
- 不自动提交 commit；完成代码和验证后等待用户 review。
- 每个任务先写/改 focused tests，再改实现；最后执行 focused tests、`pnpm typecheck`、`pnpm lint`。

---

## Current Problem

当前 `freat/shell-fix` 已经有不少正确能力，但 owner 分散：

- `apps/zcode-cli/packages/core/src/runtime/methods/bash-shell-selection.ts` 只是一组 getter/setter，不能表达完整生命周期。
- `apps/zcode-cli/packages/core/src/runtime/methods/config.ts` 负责 apply selection、刷新 pre-conversation context、patch envInfo。
- `apps/zcode-cli/packages/core/src/runtime/methods/context.ts` 直接读取 selection 并传 `effectiveShellDisplayName`。
- `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts` 直接读 snapshot、fallback、插 drift reminder。
- `apps/zcode-cli/packages/core/src/runtime/methods/events.ts` 直接持久化 snapshot。
- `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` 维护本地 `bashShellSelectionPrepared`，和 runtime 内部 selection 状态重复。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` 在 create/resume/send 多处解析和传递 shell candidate。

这导致后续维护者需要同时理解 protocol、bootstrap、runtime config、context、resume、persistence、executor 七处逻辑，容易继续漏掉 `/goal`、workflow、steer、deferred draft、resume 等入口。

## Target Shape

新增一个 runtime owner：

```ts
// apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts
export interface SessionShellEnvironment {
  selection: ExecutionShellSelection;
  promptShell: string;
}

export function getSessionShellEnvironment(
  runtime: AgentRuntimeInternal,
): SessionShellEnvironment | undefined;

export function initializeSessionShellEnvironmentIfNeeded(
  runtime: AgentRuntimeInternal,
  candidate: ExecutionShellSelection,
): boolean;

export function applySessionShellEnvironment(
  runtime: AgentRuntimeInternal,
  selection: ExecutionShellSelection | undefined,
  options?: { refreshPreConversationContext?: boolean },
): void;

export function getContextSourceShellDisplayName(
  runtime: AgentRuntimeInternal,
): string | undefined;

export function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T | undefined,
  selection: ExecutionShellSelection | undefined,
): T | undefined;
```

调用关系收敛为：

```text
settings/current env
        |
        v
bootstrap/protocol resolves candidate selection
        |
        v
runtime.initializeSessionShellEnvironmentIfNeeded(candidate)
        |
        +--> config.bashShellSelection
        +--> EnvInfo.shell / # Environment shell
        +--> Bash tool execution context
        +--> Explore child runtime
        +--> session snapshot persist/restore
```

---

## File Structure

- Create: `apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts`
  - Single owner for session shell environment lifecycle.
- Create: `apps/zcode-cli/packages/core/src/runtime/methods/context-history-entries.ts`
  - Shared `buildContextHistoryEntries()` helper，避免 owner/context-refresh 反向 import `context.ts`。
- Create: `apps/zcode-cli/packages/core/src/runtime/methods/context-refresh.ts`
  - Shared context-prefix rebuild helper，供 config model/language/style refresh 和 shell owner pre-conversation refresh 共同使用。
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/bash-shell-selection.ts`
  - Delete or reduce to compatibility re-exports after owner migration.
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`
  - Remove local shell apply/refresh helpers; delegate to owner.
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/context.ts`
  - Ask owner for context shell display override.
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts`
  - Ask owner to restore persisted shell environment and emit drift reminder.
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/events.ts`
  - Ask owner to persist current shell environment snapshot.
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
  - Ask owner for inherited child `envInfo.shell` and `bashShellSelection`.
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
  - Consume only `getBashShellSelection`; remove `bashShellOverride` fallback after runtime migration.
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
  - Consume only `context.bashShellSelection`.
- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
  - Remove runtime-level `bashShellOverride` once call sites are migrated.
- Modify: `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
  - Rename public method from `initializeBashShellSelectionIfNeeded` to `initializeSessionShellEnvironmentIfNeeded`.
- Modify: `apps/zcode-cli/packages/core/src/runtime/internal-methods.ts`
  - Same method rename for internal interface.
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`
  - Remove local `bashShellSelectionPrepared`; runtime owner decides if initialization is needed.
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/types.ts`
  - Keep `bashShellSelection` as boundary candidate; add optional app-level `platform` if bootstrap default resolution must preserve protocol test/platform injection.
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`
  - Keep protocol setting-to-selection resolver, but only pass candidate to user execution boundary/send.
- Modify: `docs/runtime-tools/bash-effective-shell-snapshot.md`
  - Update spec to name `session-shell-environment.ts` as single owner.
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`
- Test: `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`

---

### Task 1: Introduce Session Shell Environment Owner

**Files:**
- Create: `apps/zcode-cli/packages/core/src/runtime/methods/context-history-entries.ts`
- Create: `apps/zcode-cli/packages/core/src/runtime/methods/context-refresh.ts`
- Create: `apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/bash-shell-selection.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/context.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

**Interfaces:**
- Consumes: `ExecutionShellSelection`
- Produces: `SessionShellEnvironment`, `getSessionShellEnvironment()`, `initializeSessionShellEnvironmentIfNeeded()`, `applySessionShellEnvironment()`, `getContextSourceShellDisplayName()`, `applySessionShellToEnvInfo()`

- [ ] **Step 1: Add failing owner coverage through runtime trace tests**

Add a focused test in `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts` near existing shell snapshot tests:

```ts
it("initializes session shell environment once and ignores later candidates", async () => {
  const sessionId = createSessionId("runtime-session-shell-owner-once");
  const eventStore = createTestSessionEventStore();
  let requestShellDisplayName: unknown;
  const requests: Array<Array<{ role: string; content: string }>> = [];
  const firstSelection = {
    dialect: "posix" as const,
    display: { name: "zsh" },
    path: "/bin/zsh",
    source: "auto-detected" as const,
  };
  const secondSelection = {
    dialect: "posix" as const,
    display: { name: "bash" },
    path: "/bin/bash",
    source: "auto-detected" as const,
  };

  const runtime = new AgentRuntime(
    sessionId,
    {
      workingDirectory: "/workspace",
    },
    {
      contextSourcePort: {
        async resolveContextSources(request) {
          requestShellDisplayName = request.effectiveShellDisplayName;
          return {
            currentDate: "2026-06-23",
            diagnostics: [],
            envInfo: {
              cwd: "/workspace",
              nodeVersion: "v24.14.0",
              osVersion: "Linux 6.6.0",
              platform: "linux",
              shell: request.effectiveShellDisplayName ?? "fish",
            },
            workingDirectory: "/workspace",
          };
        },
      },
      eventStore,
      modelAdapter: {
        async generateText(request) {
          requests.push(
            request.messages.map((message) => ({
              content: providerContentToText(message.content),
              role: message.role,
            })),
          );
          return {
            finishReason: "stop",
            model: request.model as never,
            providerMetadata: undefined,
            text: "ok",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        },
      } as never,
    },
  );

  expect(runtime.initializeSessionShellEnvironmentIfNeeded(firstSelection)).toBe(true);
  expect(runtime.initializeSessionShellEnvironmentIfNeeded(secondSelection)).toBe(false);

  await runtime.executeTurn("check shell");

  expect(requestShellDisplayName).toBe("zsh");
  expect(providerMessagesToText(requests[0])).toContain("- Shell: zsh");
});
```

- [ ] **Step 2: Extract context history entries helper**

Create `apps/zcode-cli/packages/core/src/runtime/methods/context-history-entries.ts`:

```ts
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { ContextBuildResult } from "../deps.js";

export function buildContextHistoryEntries(
  contextResult: ContextBuildResult,
): RuntimeMessageEntry[] {
  return [
    ...contextResult.systemMessages.map((message): RuntimeMessageEntry => ({ message })),
    ...contextResult.metaUserAttachments.map((attachment) =>
      systemReminderAttachmentEntry(attachment.source, attachment.content),
    ),
  ];
}
```

Then in `apps/zcode-cli/packages/core/src/runtime/methods/context.ts`, remove the local `buildContextHistoryEntries()` function and import:

```ts
import { buildContextHistoryEntries } from "./context-history-entries.js";
```

Also remove now-unused `systemReminderAttachmentEntry` and `RuntimeMessageEntry` imports from `context.ts`.

- [ ] **Step 3: Extract context refresh helper**

Create `apps/zcode-cli/packages/core/src/runtime/methods/context-refresh.ts`:

```ts
import { countContextPrefixMessages } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildContextHistoryEntries } from "./context-history-entries.js";

export function refreshContextModelSnapshot(runtime: AgentRuntimeInternal): void {
  if (!runtime.contextBuilder || !runtime.contextInitialized) {
    // Bugfix: 首轮 context 初始化前，model/outputStyle/language 变更只能刷新同步预览，
    // 不能把 config-only fallback envInfo 写入 config.envInfo。否则真实 context source
    // 会以为 envInfo 已由外部显式提供，跳过平台和 git 探测。
    if (runtime.contextBuilder) {
      runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
        runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory),
        runtime.memoryContext,
        { persistEnvInfo: false },
      );
    }
    return;
  }

  runtime.contextBuilder = runtime.createContextBuilderFromSnapshot(
    runtime.contextSourceSnapshot ?? runtime.createConfigOnlyContextSnapshot(runtime.workingDirectory),
    runtime.memoryContext,
  );
  const effectiveContextResult = runtime.contextBuilder.build();
  const activeEntries = runtime.messageHistory.toRuntimeEntries();
  const conversationEntries = activeEntries.slice(countContextPrefixMessages(activeEntries));

  runtime.latestContextBuildResult = effectiveContextResult;
  runtime.messageHistory.replaceMessages([
    ...buildContextHistoryEntries(effectiveContextResult),
    ...conversationEntries,
  ]);
}
```

Then in `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`, replace the local `refreshContextModelSnapshot()` function with an import:

```ts
import { refreshContextModelSnapshot } from "./context-refresh.js";
```

Update all calls in `config.ts` from:

```ts
refreshContextModelSnapshot.call(this);
```

to:

```ts
refreshContextModelSnapshot(this);
```

- [ ] **Step 4: Create owner module**

Create `apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts`:

```ts
import { countContextPrefixMessages } from "../deps.js";
import type { ExecutionShellSelection } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { refreshContextModelSnapshot } from "./context-refresh.js";

export interface SessionShellEnvironment {
  selection: ExecutionShellSelection;
  promptShell: string;
}

export function getSessionShellEnvironment(
  runtime: AgentRuntimeInternal,
): SessionShellEnvironment | undefined {
  const selection = runtime.config.bashShellSelection;
  if (!selection) return undefined;
  return {
    promptShell: selection.display.name,
    selection,
  };
}

export function getSessionShellSelection(
  runtime: AgentRuntimeInternal,
): ExecutionShellSelection | undefined {
  return getSessionShellEnvironment(runtime)?.selection;
}

export function getContextSourceShellDisplayName(
  runtime: AgentRuntimeInternal,
): string | undefined {
  return getSessionShellEnvironment(runtime)?.promptShell;
}

export function initializeSessionShellEnvironmentIfNeeded(
  runtime: AgentRuntimeInternal,
  candidate: ExecutionShellSelection,
): boolean {
  if (getSessionShellEnvironment(runtime)) {
    return false;
  }
  // 修复原因：Bash shell 是 session-start 快照。所有入口都只表达“当前候选值”，
  // runtime 统一负责首次真实用户执行前初始化一次，避免 prompt shell 和执行 shell 分叉。
  applySessionShellEnvironment(runtime, candidate, { refreshPreConversationContext: true });
  return true;
}

export function applySessionShellEnvironment(
  runtime: AgentRuntimeInternal,
  selection: ExecutionShellSelection | undefined,
  options: { refreshPreConversationContext?: boolean } = {},
): void {
  runtime.config.bashShellSelection = selection;
  delete runtime.config.bashShellOverride;

  if (options.refreshPreConversationContext !== false) {
    refreshPreConversationShellContext(runtime, selection);
  }
}

export function applySessionShellToEnvInfo<T extends { shell?: string }>(
  envInfo: T | undefined,
  selection: ExecutionShellSelection | undefined,
): T | undefined {
  if (!envInfo || !selection?.display.name) return envInfo;
  return {
    ...envInfo,
    shell: selection.display.name,
  };
}

function refreshPreConversationShellContext(
  runtime: AgentRuntimeInternal,
  selection: ExecutionShellSelection | undefined,
): void {
  if (
    !selection ||
    !runtime.contextBuilder ||
    !runtime.contextInitialized ||
    !runtime.contextSourceSnapshot ||
    runtime.sessionPersisted
  ) {
    return;
  }

  const activeEntries = runtime.messageHistory.toRuntimeEntries();
  if (activeEntries.length !== countContextPrefixMessages(activeEntries)) {
    return;
  }

  runtime.config.envInfo = applySessionShellToEnvInfo(runtime.config.envInfo, selection);
  runtime.contextSourceSnapshot = {
    ...runtime.contextSourceSnapshot,
    envInfo: applySessionShellToEnvInfo(runtime.contextSourceSnapshot.envInfo, selection)!,
  };
  refreshContextModelSnapshot(runtime);
}
```

- [ ] **Step 5: Convert old helper to compatibility wrapper**

Replace `apps/zcode-cli/packages/core/src/runtime/methods/bash-shell-selection.ts` with:

```ts
export {
  applySessionShellEnvironment as setEffectiveBashShellSelection,
  getSessionShellSelection as getEffectiveBashShellSelection,
} from "./session-shell-environment.js";
```

This keeps existing call sites compiling while later tasks migrate names.

- [ ] **Step 6: Rename runtime public initialization method in-place**

In `agent-runtime.ts`, `internal-methods.ts`, and `methods/index.ts`, replace the old method name in-place:

```ts
initializeSessionShellEnvironmentIfNeeded(selection: ExecutionShellSelection): boolean;
```

Do not keep a temporary public alias for `initializeBashShellSelectionIfNeeded`; update call sites in this same task so there is only one runtime API name.

- [ ] **Step 7: Run focused test**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-trace.test.ts
```

Expected: runtime trace tests pass. The new test proves the owner API initializes once and produces the provider-visible shell display used by context.

---

### Task 2: Move Runtime Context Mutation Into The Owner

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/config.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/context.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/internal-methods.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-trace.test.ts`

**Interfaces:**
- Consumes: owner functions from Task 1
- Produces: public runtime method `initializeSessionShellEnvironmentIfNeeded(selection): boolean`

- [ ] **Step 1: Verify there is no config/owner import cycle**

Confirm these import directions:

```text
config.ts -> session-shell-environment.ts
config.ts -> context-refresh.ts
session-shell-environment.ts -> context-refresh.ts
context-refresh.ts -> context-history-entries.ts
context.ts -> session-shell-environment.ts
context.ts -> context-history-entries.ts
```

There must be no import from `session-shell-environment.ts` to `config.ts`, and no import from `context-refresh.ts` to `context.ts`.

- [ ] **Step 2: Replace config shell apply logic**

In `config.ts`, remove local `applyBashShellSelection()`, `initializeBashShellSelectionIfNeeded()`, `refreshPreConversationShellContext()`, and `updateEnvInfoShell()`.

Import the owner:

```ts
import {
  applySessionShellEnvironment,
  initializeSessionShellEnvironmentIfNeeded as initializeSessionShellEnvironment,
} from "./session-shell-environment.js";
```

Update `updateConfig()` shell branch:

```ts
if ("bashShellSelection" in patch || "bashShellOverride" in patch) {
  applySessionShellEnvironment(this, patch.bashShellSelection ?? patch.bashShellOverride, {
    refreshPreConversationContext: true,
  });
}
```

Add exported method:

```ts
export function initializeSessionShellEnvironmentIfNeeded(
  this: AgentRuntimeInternal,
  selection: ExecutionShellSelection,
): boolean {
  return initializeSessionShellEnvironment(this, selection);
}
```

- [ ] **Step 3: Make context consume owner, not raw config**

In `context.ts`, replace:

```ts
const bashShellSelection = getEffectiveBashShellSelection(this);
```

with:

```ts
const shellDisplayName = getContextSourceShellDisplayName(this);
```

and pass:

```ts
effectiveShellDisplayName: shellDisplayName,
```

This keeps `ContextSourceRequest.effectiveShellDisplayName` as a dumb transport field; the owner remains the only runtime shell decision point.

- [ ] **Step 4: Verify runtime public method has a single name**

Confirm `agent-runtime.ts`, `internal-methods.ts`, and `methods/index.ts` only expose:

```ts
initializeSessionShellEnvironmentIfNeeded(selection: ExecutionShellSelection): boolean;
```

and no longer expose:

```ts
initializeBashShellSelectionIfNeeded(selection: ExecutionShellSelection): boolean;
```

Update any remaining bootstrap/tests call sites to use `initializeSessionShellEnvironmentIfNeeded`.

- [ ] **Step 5: Run focused runtime tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-trace.test.ts tests/context-builder.test.ts
```

Expected: runtime trace and context builder tests pass.

---

### Task 3: Move Snapshot Persistence And Resume Restore Into The Owner

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/bash-shell-snapshot.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/events.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts`
- Test: `apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts`

**Interfaces:**
- Consumes: `readPersistedBashShellSelectionSnapshot()`, `resolveBashShellSnapshotForResume()`, `persistBashShellSelectionSnapshot()`
- Produces: `persistSessionShellEnvironmentSnapshot(runtime, traceContext)`, `restoreSessionShellEnvironmentSelectionForResume(runtime, options)`, and `announceSessionShellEnvironmentDriftAfterResume(runtime, options)`

- [ ] **Step 1: Add owner persistence wrappers**

In `session-shell-environment.ts`, add:

```ts
import type { EnvInfo, TraceContext } from "../deps.js";
import {
  persistBashShellSelectionSnapshot,
  readPersistedBashShellSelectionSnapshot,
  resolveBashShellSnapshotForResume,
  type BashShellSnapshotRestore,
} from "./bash-shell-snapshot.js";
import {
  buildShellEnvironmentChangeReminder,
  hasShellDisplayChanged,
} from "./shell-environment.js";

export async function persistSessionShellEnvironmentSnapshot(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  await persistBashShellSelectionSnapshot({
    logger: runtime.logger,
    selection: getSessionShellSelection(runtime),
    sessionId: runtime.sessionId,
    sessionStore: runtime.sessionStore,
    traceContext,
  });
}

export async function restoreSessionShellEnvironmentSelectionForResume(
  runtime: AgentRuntimeInternal,
  options: {
    currentSelection: ExecutionShellSelection | undefined;
    traceContext: TraceContext;
  },
): Promise<BashShellSnapshotRestore> {
  const restore = resolveBashShellSnapshotForResume({
    currentSelection: options.currentSelection,
    logger: runtime.logger,
    restore: await readPersistedBashShellSelectionSnapshot({
      logger: runtime.logger,
      sessionId: runtime.sessionId,
      sessionStore: runtime.sessionStore,
      traceContext: options.traceContext,
    }),
    traceContext: options.traceContext,
  });

  if (restore.status === "restored" || restore.status === "fallback") {
    applySessionShellEnvironment(runtime, restore.selection, {
      refreshPreConversationContext: false,
    });
  }

  return restore;
}

export function announceSessionShellEnvironmentDriftAfterResume(
  runtime: AgentRuntimeInternal,
  options: {
    persistedEnvInfo: EnvInfo | undefined;
    restore: BashShellSnapshotRestore;
  },
): void {
  if (
    options.restore.status !== "restored" &&
    hasShellDisplayChanged(options.persistedEnvInfo?.shell, getSessionShellSelection(runtime))
  ) {
    // 修复原因：旧 session 没有可用的 runtime/bash_shell_selection 快照，或快照失效后
    // 只能使用当前 fallback selection。历史 # Environment 仍显示旧 Shell，必须补
    // provider-visible reminder，避免模型误以为 Bash 仍在旧 shell 下执行。
    runtime.messageHistory.addAttachment(
      "shell_environment_change",
      buildShellEnvironmentChangeReminder(getSessionShellSelection(runtime)),
    );
  }
}
```

- [ ] **Step 2: Simplify events persistence**

In `events.ts`, replace direct `persistBashShellSelectionSnapshot(...)` with:

```ts
await persistSessionShellEnvironmentSnapshot(this, traceContext);
```

Remove direct imports of `persistBashShellSelectionSnapshot` and `getEffectiveBashShellSelection`.

- [ ] **Step 3: Simplify resume restore**

In `resume.ts`, replace the direct snapshot read/resolve/apply block before context initialization with:

```ts
const shellRestore = await restoreSessionShellEnvironmentSelectionForResume(this, {
  currentSelection: getSessionShellSelection(this),
  traceContext,
});
```

Then after `hydrateMessageHistoryFromSession(...)`, replace `announceLegacyBashShellDriftIfNeeded(...)` with:

```ts
announceSessionShellEnvironmentDriftAfterResume(this, {
  persistedEnvInfo,
  restore: shellRestore,
});
```

This timing matters: `messageHistory` is reset and hydrated during resume, so the provider-visible drift attachment must be added after hydration, not during the early selection restore.

- [ ] **Step 4: Keep `bash-shell-snapshot.ts` as storage codec only**

After Step 3, `bash-shell-snapshot.ts` should only know how to:

- persist serialized selection
- read serialized selection
- validate persisted selection usability
- resolve stale persisted selection against a current fallback candidate

It must not mutate runtime config or message history.

- [ ] **Step 5: Run persistence tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-persistence.test.ts
```

Expected: tests cover restored snapshot, stale snapshot fallback, legacy session drift reminder, and invalid snapshot fallback.

---

### Task 4: Collapse Bootstrap And Protocol Initialization Around Runtime Owner

**Files:**
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/types.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/input-facade.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/workflow-methods.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/workflow-facade.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-methods.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`

**Interfaces:**
- Consumes: `runtime.initializeSessionShellEnvironmentIfNeeded(candidate)`
- Produces: one user execution boundary implementation with no local duplicate prepared flag

- [ ] **Step 1: Add app-level platform injection for default shell resolution**

In `apps/zcode-cli/packages/bootstrap/src/app/types.ts`, add to `ZCodeAppOptions`:

```ts
platform?: NodeJS.Platform | string;
```

In `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`, pass protocol platform through when creating app options:

```ts
platform: context.deps.platform,
```

Keep existing `env: context.deps.env` behavior unchanged.

- [ ] **Step 2: Remove local prepared state from app bootstrap**

In `create-app.ts`, delete:

```ts
let bashShellSelectionPrepared = Boolean(
  runtimeConfig.bashShellSelection ?? runtimeConfig.bashShellOverride,
);
```

Replace `initializeBashShellSelection()` with:

```ts
const resolveDefaultShellSelection = (): ExecutionShellSelection =>
  resolveEffectiveBashShellSelection({
    env: options.env ?? process.env,
    platform: options.platform ?? process.platform,
  }).selection;

const initializeSessionShellEnvironment = (candidate?: ExecutionShellSelection): void => {
  const selection = candidate ?? resolveDefaultShellSelection();
  getRuntime().initializeSessionShellEnvironmentIfNeeded(selection);
};
```

This makes runtime config the only initialized/not-initialized truth.

- [ ] **Step 3: Update resume boundary**

In `resumeFromStore()`, keep current fallback behavior but call the renamed function:

```ts
initializeSessionShellEnvironment();
const result = await runtime.resumeFromStore({ traceContext: resumeTraceContext });
```

This current selection is only a fallback candidate; persisted snapshot wins inside runtime owner.

- [ ] **Step 4: Update user execution boundary**

In `prepareUserExecutionBoundary`, replace:

```ts
initializeBashShellSelection(boundaryOptions?.bashShellSelection);
```

with:

```ts
initializeSessionShellEnvironment(boundaryOptions?.bashShellSelection);
```

Do not add special cases for `/goal`, workflow, or deferred draft here; they should all call this single boundary.

- [ ] **Step 5: Keep protocol resolver as candidate producer only**

In `server-operations.ts`, keep `resolveProtocolBashShellSelection()` but treat its result as a candidate:

```ts
const bashShellSelectionCandidate = resolveProtocolBashShellSelection(
  context,
  params.integratedTerminalShell,
);
```

Pass it to `record.app.sendInput(..., { bashShellSelection: bashShellSelectionCandidate })`.

Do not pass shell selection through `session/create` for non-resume draft creation.

- [ ] **Step 6: Update protocol tests**

In `zcode-protocol.test.ts`, assert:

- deferred `session/create` does not initialize shell selection
- first `session/send` initializes shell selection from current setting candidate
- second `session/send` with a different candidate does not overwrite runtime selection
- cold `session/resume` restores persisted snapshot when present
- cold legacy resume uses current candidate as fallback and emits shell drift reminder only when prompt-visible shell changed

Use existing test helpers around lines where `recordShellInitialization()` is already present; remove assertions that depend on local bootstrap `bashShellSelectionPrepared`.

- [ ] **Step 7: Run bootstrap protocol tests**

Run:

```bash
pnpm --filter @zcode/bootstrap exec vitest run tests/zcode-protocol.test.ts
```

Expected: protocol tests pass.

---

### Task 5: Remove Runtime `bashShellOverride` As A State Source

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts`
- Modify: `apps/zcode-cli/packages/core/src/runtime/internal-methods.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/call-runner.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/executor/impl.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/types.ts`
- Modify: `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
- Test: `apps/zcode-cli/packages/core/tests/bash-handler.test.ts`

**Interfaces:**
- Consumes: `ExecutionShellSelection`
- Produces: only one runtime field: `bashShellSelection`

- [ ] **Step 1: Remove runtime config override field**

In `AgentRuntimeConfig`, delete:

```ts
bashShellOverride?: ExecutionShellOverride | undefined;
```

Keep `ExecutionShellOverride` in `@zcode/contracts` because the low-level execution boundary still names `shellOverride` on `ExecutionCommand`.

- [ ] **Step 2: Update runtime updateConfig patch type**

In `agent-runtime.ts`, `internal-methods.ts`, and `config.ts`, remove `"bashShellOverride"` from the `Pick<AgentRuntimeConfig, ...>` lists.

In `config.ts`, shell branch becomes:

```ts
if ("bashShellSelection" in patch) {
  applySessionShellEnvironment(this, patch.bashShellSelection, {
    refreshPreConversationContext: true,
  });
}
```

- [ ] **Step 3: Update tool execution context**

In `call-runner.ts`, replace:

```ts
bashShellSelection: deps.getBashShellSelection?.() ?? deps.bashShellSelection,
bashShellOverride: deps.getBashShellOverride?.() ?? deps.bashShellOverride,
```

with:

```ts
bashShellSelection: deps.getBashShellSelection?.() ?? deps.bashShellSelection,
```

Remove `bashShellOverride` from executor dependency types.

- [ ] **Step 4: Update Bash handler**

In `bash.ts`, replace:

```ts
const shellSelection = context.bashShellSelection ?? context.bashShellOverride;
```

with:

```ts
const shellSelection = context.bashShellSelection;
```

Keep the execution command field name:

```ts
shellOverride: shellSelection,
```

because `ExecutionCommand` is the adapter boundary and already documents that this is Bash-only.

- [ ] **Step 5: Run Bash handler tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/bash-handler.test.ts
```

Expected: Bash tests pass and no call site still references runtime-level `bashShellOverride`.

- [ ] **Step 6: Confirm no stale runtime override refs**

Run:

```bash
rg -n "bashShellOverride|getBashShellOverride" apps/zcode-cli/packages/core apps/zcode-cli/packages/bootstrap
```

Expected: no hits in core/bootstrap runtime state. Hits in contracts/adapters are acceptable only for the low-level `ExecutionCommand.shellOverride` boundary.

---

### Task 6: Update Explore Inheritance Through The Owner

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- Test: `apps/zcode-cli/packages/core/tests/subagent-explore.test.ts`

**Interfaces:**
- Consumes: `getSessionShellEnvironment()`
- Produces: child `envInfo.shell` and child `bashShellSelection` from the same parent environment

- [ ] **Step 1: Replace direct selection reads**

In `subagent.ts`, replace:

```ts
const bashShellSelection = getEffectiveBashShellSelection(this);
const childEnvInfo = {
  ...baseChildEnvInfo,
  ...(bashShellSelection ? { shell: bashShellSelection.display.name } : {}),
};
```

with:

```ts
const shellEnvironment = getSessionShellEnvironment(this);
const childEnvInfo = {
  ...baseChildEnvInfo,
  ...(shellEnvironment ? { shell: shellEnvironment.promptShell } : {}),
};
const bashShellSelection = shellEnvironment?.selection;
```

- [ ] **Step 2: Keep child runtime config minimal**

When creating child `AgentRuntime`, pass only:

```ts
bashShellSelection,
envInfo: childEnvInfo,
```

Do not pass any shell override alias.

- [ ] **Step 3: Run Explore tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/subagent-explore.test.ts
```

Expected: Explore child prompt shell and Bash execution selection both inherit parent session-start shell.

---

### Task 7: Update Documentation And Remove Superseded Mental Model

**Files:**
- Modify: `docs/runtime-tools/bash-effective-shell-snapshot.md`
- Modify: `docs/superpowers/plans/2026-06-19-bash-effective-shell-snapshot.md`

**Interfaces:**
- Produces: docs that name the single owner and mark old plan as historical

- [ ] **Step 1: Update runtime tool spec**

In `docs/runtime-tools/bash-effective-shell-snapshot.md`, add a new section after “核心契约”:

```md
## Runtime Owner

`apps/zcode-cli/packages/core/src/runtime/methods/session-shell-environment.ts` 是 session shell environment 的唯一 owner。

它负责：

- 初始化 session-start shell snapshot。
- 对 `EnvInfo.shell` 应用 provider-visible display name。
- 为 Bash executor 提供 `ExecutionShellSelection`。
- 持久化和恢复 `runtime/bash_shell_selection`。
- 在 legacy / stale resume fallback 时插入 `shell_environment_change` attachment。

bootstrap、protocol、services、UI 只能提供当前候选 selection，不能直接修改已初始化 session 的 shell environment。
```

- [ ] **Step 2: Mark old plan as superseded**

At the top of `docs/superpowers/plans/2026-06-19-bash-effective-shell-snapshot.md`, add:

```md
> Superseded by `docs/superpowers/plans/2026-06-23-session-shell-environment-owner.md`.
> This document records the original shell snapshot implementation plan; the current refactor plan centralizes lifecycle ownership in `session-shell-environment.ts`.
```

- [ ] **Step 3: Run markdown grep sanity**

Run:

```bash
rg -n "bashShellOverride|effectiveShellDisplayName|session-shell-environment|runtime/bash_shell_selection" docs/runtime-tools docs/superpowers/plans/2026-06-19-bash-effective-shell-snapshot.md docs/superpowers/plans/2026-06-23-session-shell-environment-owner.md
```

Expected: docs mention `bashShellOverride` only as a removed runtime concept or low-level execution boundary; docs name `session-shell-environment.ts` as owner.

---

### Task 8: Full Verification

**Files:**
- No source edits unless tests reveal a missed migration.

**Interfaces:**
- Produces: verified refactor with same behavior and lower complexity

- [ ] **Step 1: Run focused package tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run \
  tests/runtime-trace.test.ts \
  tests/runtime-persistence.test.ts \
  tests/subagent-explore.test.ts \
  tests/bash-handler.test.ts
```

Expected: all selected core tests pass.

- [ ] **Step 2: Run bootstrap tests**

Run:

```bash
pnpm --filter @zcode/bootstrap exec vitest run tests/zcode-protocol.test.ts
```

Expected: protocol shell initialization, deferred draft, resume, and send tests pass.

- [ ] **Step 3: Run adapter tests if shell resolver changed**

If Task 2 touched `apps/zcode-cli/packages/adapters/src/exec/bash-shell-provider.ts` or `apps/zcode-cli/packages/adapters/src/exec/index.ts`, run:

```bash
pnpm --filter @zcode/adapters exec vitest run tests/exec.test.ts tests/fs-context.test.ts
```

Expected: adapters tests pass.

- [ ] **Step 4: Run repo-wide required checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both pass.

- [ ] **Step 5: Final behavior audit**

Run:

```bash
rg -n "initializeBashShellSelectionIfNeeded|bashShellSelectionPrepared|getBashShellOverride|bashShellOverride" apps/zcode-cli/packages/core apps/zcode-cli/packages/bootstrap
```

Expected:

- no `initializeBashShellSelectionIfNeeded`
- no `bashShellSelectionPrepared`
- no `getBashShellOverride`
- no runtime-level `bashShellOverride`

Run:

```bash
rg -n "getSessionShellEnvironment|initializeSessionShellEnvironmentIfNeeded|restoreSessionShellEnvironmentSelectionForResume|announceSessionShellEnvironmentDriftAfterResume|persistSessionShellEnvironmentSnapshot" apps/zcode-cli/packages/core apps/zcode-cli/packages/bootstrap
```

Expected:

- owner functions are used by context, config, resume, events, subagent, and bootstrap user execution boundary
- protocol/services do not directly mutate runtime shell state

## Acceptance Criteria

- New session: shell selection is undefined until first real user execution boundary.
- First send: current setting candidate initializes session shell environment once.
- Later send in same session: changed setting candidate is ignored.
- Bash tool execution and `# Environment` Shell use the same `ExecutionShellSelection.display.name`.
- deferred draft: prewarm does not freeze shell setting; first send does.
- `/goal`, expert workflow, script workflow: call the same user execution boundary before first persisted/executed state.
- resume with valid snapshot: uses persisted shell and does not insert drift reminder.
- resume with stale snapshot: does not pass stale path to executor; falls back to current candidate and inserts drift reminder if historical Shell differs.
- legacy resume without snapshot: uses current candidate and inserts drift reminder only when historical Shell differs.
- Explore child runtime: inherits parent session shell environment for both prompt and Bash execution.
- No runtime state path still treats `bashShellOverride` as a second source of truth.
- `pnpm typecheck` and `pnpm lint` pass.

## Self-Review Checklist

- [ ] 每个 shell lifecycle 行为都能指向 `session-shell-environment.ts` 中的一个 owner function。
- [ ] bootstrap/protocol 只生产候选 selection，不维护“是否已初始化”的本地状态。
- [ ] context、Bash executor、Explore、resume、persistence 没有各自拼 shell display 的逻辑。
- [ ] provider-visible shell name 仍然不包含绝对 path。
- [ ] Windows/macOS/Linux fallback 行为没有变成 hard spawn error。
- [ ] 文档和测试都不再要求维护者理解旧的多 owner mental model。
