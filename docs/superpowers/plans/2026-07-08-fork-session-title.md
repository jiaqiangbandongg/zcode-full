# Fork Session Title Implementation Plan

**Goal:** Make forked sessions appear in v4 sessions-index with their persisted `Fork of <parent title>` title and parent session relation.

**Architecture:** Runtime resume will publish persisted session title into the current session event stream, so `ProductProjection.meta` becomes the single live title source. Bootstrap live records will preserve `parentSessionId` and expose it through `getSessionIndexMeta`, allowing sessions-index summaries to retain fork identity.

**Tech Stack:** TypeScript, Vitest, ZCode runtime event store, v4 ProductProjection, sessions-index publisher.

## Global Constraints

- Write the spec before implementation and keep it under `docs/`.
- Use TDD: write failing tests before production code.
- Do not fix this in UI fallback; title truth must come from runtime/events.
- Preserve desktop `desktop-continuous` and web remote `web-remote-replayable` semantics.
- Run `pnpm typecheck` and `pnpm lint` before completion.

---

### Task 1: Add Regression Coverage

**Files:**
- Modify: `apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/tests/v4-cold-resume.test.ts`

**Interfaces:**
- Consumes: `AgentRuntime.resumeFromStore()`, `ZCodeProtocolAgentServer` v4 cold subscribe, sessions-index subscribe.
- Produces: failing tests proving persisted fork title must become a runtime event and live sessions-index summaries must include `parentSessionId`.

- [x] **Step 1: Write the failing core resume test**

Add a test that creates a persisted fork child with `title: "Fork of Checkpoint复现目标"` and `titleSource: "generated"`, calls `resumeFromStore()`, and asserts `SessionTitleUpdated` appears before `SessionResumed`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-persistence.test.ts -t "emits persisted generated title before SessionResumed"
```

Expected before implementation: failure because `titleEventIndex === -1`.

- [x] **Step 3: Write and run the live parent regression**

Extend `v4-cold-resume.test.ts` so the persisted session has `parentID`. Assert the resumed sessions-index summary includes `parentSessionId`.

Run:

```bash
pnpm --filter @zcode/bootstrap exec vitest run tests/v4-cold-resume.test.ts -t "重启后冷订阅"
```

Expected before implementation: failure because `resumedSummary.parentSessionId` is `undefined`.

### Task 2: Preserve Parent Session Identity in Live Index Meta

**Files:**
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts`

**Interfaces:**
- Consumes: `params.parentSessionId` from create/fork record params and persisted `session.parentID` from resume.
- Produces: `ZCodeProtocolSessionRecord.parentSessionId?: string` and `getSessionIndexMeta(...).parentSessionId`.

- [x] **Step 1: Implement record parent propagation**

Add `parentSessionId?: string` to `ZCodeProtocolSessionRecord`. In `createRecord`, set it when `params.parentSessionId` exists. In `resumeSession`, after loading persisted session, set `record.parentSessionId = String(session.parentID)` when present. In `forkSession`, pass `parentSessionId: fork.parentSessionId` into `createRecord`.

- [x] **Step 2: Expose parent through v4 bridge**

Change `getSessionIndexMeta` to return:

```ts
return {
  createdAt: record.createdAt,
  lastActivityAt: record.updatedAt,
  ...(record.parentSessionId ? { parentSessionId: record.parentSessionId } : {}),
};
```

- [x] **Step 3: Run targeted test**

Run:

```bash
pnpm --filter @zcode/bootstrap exec vitest run tests/v4-cold-resume.test.ts -t "重启后冷订阅"
```

Expected: the parent relation assertion passes.

### Task 3: Sync Persisted Title on Resume

**Files:**
- Modify: `apps/zcode-cli/packages/core/src/runtime/methods/resume.ts`

**Interfaces:**
- Consumes: persisted `SessionInfo.title` and `SessionInfo.titleSource`.
- Produces: `SessionTitleUpdated` in the current runtime event stream, before `SessionResumed`.

- [x] **Step 1: Add title sync during resume**

After `this.sessionPersisted = true` and before `SessionResumed`, if `session.title.trim()` is non-empty, append:

```ts
SessionEventType.SessionTitleUpdated
```

with `previousTitle: ""`, `title: session.title`, and `source: session.titleSource ?? "generated"`.

- [x] **Step 2: Add Chinese bug comment**

Document that session store title was already correct, but v4 live projection only consumes `SessionTitleUpdated`; without this event, fork child sessions appear as empty-title fallbacks.

- [x] **Step 3: Run targeted tests**

Run:

```bash
pnpm --filter @zcode/core exec vitest run tests/runtime-persistence.test.ts -t "emits persisted generated title before SessionResumed"
pnpm --filter @zcode/bootstrap exec vitest run tests/v4-cold-resume.test.ts -t "重启后冷订阅"
```

Expected: both pass.

### Task 4: Full Verification and Commit

**Files:**
- All modified source, tests, and docs.

**Interfaces:**
- Produces: verified bug fix and Conventional Commit.

- [x] **Step 1: Run required checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: exit code 0 for both.

- [x] **Step 2: Review diff**

Run:

```bash
git diff -- docs/superpowers/specs/2026-07-08-fork-session-title-design.md docs/superpowers/plans/2026-07-08-fork-session-title.md apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts apps/zcode-cli/packages/core/src/runtime/methods/resume.ts apps/zcode-cli/packages/bootstrap/tests/v4-cold-resume.test.ts apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts
```

Expected: only scoped fork title / parent meta changes.

- [ ] **Step 3: Commit**

Run:

```bash
git add docs/superpowers/specs/2026-07-08-fork-session-title-design.md docs/superpowers/plans/2026-07-08-fork-session-title.md apps/zcode-cli/packages/core/tests/runtime-persistence.test.ts apps/zcode-cli/packages/core/src/runtime/methods/resume.ts apps/zcode-cli/packages/bootstrap/tests/v4-cold-resume.test.ts apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts
git commit -m "fix(v4): preserve fork session titles"
```
