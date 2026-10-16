# Conversation Share Artifact Upload Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with TDD; keep the existing branch and preserve unrelated user changes.

**Goal:** Publish explicitly registered result artifacts from selected conversation turns by uploading them between preparation and confirmation.

**Architecture:** Extend the formal V4 row protocol with an artifact row projected from completed tool attachments. The share service materializes only selected artifact rows through an injected async local file reader, validates capabilities and integrity, creates a preparation with the exact count, uploads multipart descriptors/files in deterministic order, then confirms the unchanged public projection.

**Tech Stack:** TypeScript, Zod, Vitest, Node async file APIs, existing ZCode V4 projection and conversation-share HTTP client.

---

### Task 1: Freeze product and protocol semantics

**Files:**
- Modify: `docs/superpowers/specs/2026-08-10-conversation-share-api-integration-design.md`
- Modify: `docs/conversation-session-case-catalog.md`
- Modify: `docs/testing/conversation-session-e2e-coverage-matrix.md`

Record source authority, state pruning, upload ordering, integrity, failure behavior, and desktop/remote boundaries before code.

### Task 2: Add the formal artifact row

**Files:**
- Modify: `packages/shared/src/zcode-protocol-v4/rows.ts`
- Modify: `packages/shared/src/conversation-share.ts`
- Test: `packages/shared/test/conversationShareContract.test.ts`
- Modify: `apps/zcode-cli/packages/contracts/src/events/session.events.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/product-projection.test.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/transcript-hydration.test.ts`

Write failing schema/live/cold tests, then project completed tool attachments as deterministic artifact rows. Keep text-only paths unrecognized.

### Task 3: Build a safe public artifact projection

**Files:**
- Modify: `packages/services/src/conversation-share/conversationSharePublicProjection.ts`
- Test: `packages/services/test/conversationSharePublicProjection.test.ts`

Write failing tests, then replace local artifact identity/ref with stable public IDs and return upload source metadata beside the public rows.

### Task 4: Materialize and upload selected artifacts

**Files:**
- Add: `packages/services/src/conversation-share/conversationShareArtifactSource.ts`
- Add: `packages/services/test/conversationShareArtifactSource.test.ts`
- Modify: `packages/services/src/conversation-share/conversationShareService.ts`
- Modify: `packages/services/src/node.ts`
- Test: `packages/services/test/conversationShareService.test.ts`

Write failing tests for selected/unselected artifacts, capabilities, file integrity, prepare count, upload order, upload response verification, and no-confirm-on-failure. Implement an injected async local file source with realpath workspace containment and bounded chunk reads; upload all artifacts before confirm.

### Task 5: Verify and commit

Run affected tests, `pnpm typecheck`, and `pnpm lint`. Review the diff for unrelated changes and secret/file-content logs, then commit only task files with a Conventional Commit message.
