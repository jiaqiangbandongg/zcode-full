# Conversation Share Historical Artifact Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upload supported PDF/PPTX/DOCX/HTML/image results shown by selected historical conversation turns even when their generating tools did not register formal artifact attachments.

**Architecture:** Extend `conversationRowsRangeV4` with the projection revision so the share service can query selected turn headers through `conversationFileChangesV4` at one revision/epoch. Materialize explicit artifact rows and supported file-change candidates through one async local source, deduplicate by canonical realpath with explicit rows winning, synthesize transient artifact rows, then reuse the existing public projection and prepare/upload/confirm pipeline.

**Tech Stack:** TypeScript, Zod, Vitest, Node async file APIs, ZCode V4 conversation protocol, existing conversation-share service and HTTP client.

## Global Constraints

- Update specs and conversation case coverage before production code; completed in commit `b7c52e49a2`.
- Do not parse assistant text, Bash commands, stdout, or scan the workspace.
- Only local desktop publishing is enabled; do not change remote workspace or mobile replayable behavior.
- All file IO remains asynchronous and validates canonical realpath containment inside the workspace.
- Materialize and hash every artifact before creating a preparation.
- Preserve unrelated user changes in the dirty worktree.
- Run `pnpm typecheck` and `pnpm lint` before completion.

---

### Task 1: Expose a consistent file-change query watermark

**Files:**

- Modify: `packages/shared/src/zcode-protocol-v4/transport.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/conversation-topic-publisher.test.ts`
- Modify fixtures that construct `V4ConversationRowsRangeResult` in affected tests.

**Interfaces:**

- Produces: `V4ConversationRowsRangeResult.atRevision: number`.
- Consumes: current `ConversationSnapshot.revision` from `ConversationTopicPublisher`.

- [ ] **Step 1: Write the failing protocol/publisher test**

Assert that `publisher.getRowsRange(...)` returns both `atLogEpoch` and the current snapshot `atRevision`, and that a structural event changes the returned revision.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run apps/zcode-cli/packages/bootstrap/tests/conversation-topic-publisher.test.ts`

Expected: FAIL because `atRevision` is absent.

- [ ] **Step 3: Add the required schema field and publisher value**

Add this required field to the strict result schema:

```ts
atRevision: z.number().int().nonnegative(),
```

Return `snapshot.revision` from `getRowsRange`. Update typed fixtures mechanically; do not make the field optional.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run apps/zcode-cli/packages/bootstrap/tests/conversation-topic-publisher.test.ts`

Expected: PASS.

### Task 2: Materialize files with canonical identity

**Files:**

- Modify: `packages/services/src/conversation-share/conversationShareArtifactSource.ts`
- Test: `packages/services/test/conversationShareArtifactSource.test.ts`

**Interfaces:**

- Produces: `ConversationShareMaterializedArtifact { bytes: Uint8Array; canonicalPath: string }`.
- Changes: `ConversationShareArtifactSource.read(input)` returns the materialized object instead of bare bytes.

- [ ] **Step 1: Write the failing canonical-path test**

Assert that reading a workspace file returns its bytes and canonical realpath, while outside paths and outward symlinks still fail closed.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm vitest run packages/services/test/conversationShareArtifactSource.test.ts`

Expected: FAIL because `read` currently returns only `Uint8Array`.

- [ ] **Step 3: Return bytes and canonical path from the existing safe read**

Keep the current async `realpath -> open -> stat -> bounded read` sequence and change only the successful return shape:

```ts
return { bytes: new Uint8Array(buffer.subarray(0, bytesRead)), canonicalPath: artifactRealPath };
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm vitest run packages/services/test/conversationShareArtifactSource.test.ts`

Expected: PASS.

### Task 3: Discover and upload selected historical results

**Files:**

- Modify: `packages/services/src/conversation-share/conversationShareService.ts`
- Test: `packages/services/test/conversationShareService.test.ts`

**Interfaces:**

- Consumes: `conversationRowsRangeV4`, `conversationFileChangesV4`, `ConversationShareArtifactSource.read`.
- Produces: the unchanged `IConversationShareService.publishTextConversation` API and unchanged HTTP DTOs.

- [ ] **Step 1: Write failing service tests for SHARE08-SHARE11**

Add focused tests proving:

```text
selected PDF + PPTX fileChanges -> prepare(count=2) -> two uploads -> confirm
unselected turn or unsupported source file -> no artifact IO/upload
formal artifact + fileChanges same canonicalPath -> one upload, formal metadata wins
reverted fileChanges -> no discovered artifact
rows pagination watermark mismatch or stale fileChanges query -> fail before preparation
```

Use a fake source that returns real bytes plus canonical paths; assert on request bodies and orchestration order, not only mock call counts.

- [ ] **Step 2: Run the service test and verify RED**

Run: `pnpm vitest run packages/services/test/conversationShareService.test.ts`

Expected: FAIL because the service neither calls `conversationFileChangesV4` nor creates transient artifact rows.

- [ ] **Step 3: Return rows with their read watermark**

Refactor `loadAllRows` to return:

```ts
{ rows: ConversationRow[]; revision: number; logEpoch: string }
```

Require every page to have identical `atRevision` and `atLogEpoch`; otherwise throw `invalid_conversation` before any preparation request.

- [ ] **Step 4: Query only selected headers that advertise file changes**

After selection, for each selected terminal `turnHeader` whose `fileChanges.files > 0`, call:

```ts
conversationFileChangesV4({
  workspacePath,
  workspaceIdentity,
  sessionId,
  target: { rowId: header.rowId, entityId: header.entityId! },
  baseRevision: watermark.revision,
  baseLogEpoch: watermark.logEpoch,
});
```

Require the stable `entityId` needed by the V4 target. Map stale revision/epoch failures to `invalid_conversation`; propagate other structured service failures.

- [ ] **Step 5: Filter and materialize candidates before preparation**

Normalize the item extension and match it against `capabilities.allowed_artifacts`. Materialize explicit rows first, then selected active file-change candidates. For discovered candidates derive MIME/type from the matched capability, compute current size and SHA-256, and build deterministic transient `ArtifactRow` values associated with the selected header.

Deduplicate by `canonicalPath`; explicit rows win. Unsupported extensions, unselected turns, and `state: "reverted"` create no transient row. Enforce count/byte limits after the merged set is known.

- [ ] **Step 6: Reuse public projection and upload pipeline**

Insert each transient artifact after the source turn's existing selected rows, call `buildConversationSharePublicProjection`, and upload the already materialized bytes in deterministic row order. Do not reread files after preparation. Preserve confirmed-preparation short-circuit semantics without uploading.

- [ ] **Step 7: Run service and artifact-source tests and verify GREEN**

Run:

```bash
pnpm vitest run packages/services/test/conversationShareService.test.ts packages/services/test/conversationShareArtifactSource.test.ts
```

Expected: PASS.

### Task 4: Verify integration boundaries and commit

**Files:**

- Update: `docs/testing/conversation-session-e2e-coverage-matrix.md` statuses for SHARE08-SHARE11 after tests pass.
- Review all task files only.

- [ ] **Step 1: Run affected package tests**

Run protocol/publisher, service, source, public-projection, and HTTP-client focused tests.

- [ ] **Step 2: Run required repository checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: exit 0; existing warnings may remain but no new errors.

- [ ] **Step 3: Review the scoped diff**

Verify no assistant/Bash text parsing, no workspace scan, no sync file IO, no token/file-content logs, no remote/mobile behavior change, and no unrelated dirty files are staged.

- [ ] **Step 4: Commit**

```bash
git add <only task files>
git commit -m "fix(conversation-share): upload historical result files"
```
