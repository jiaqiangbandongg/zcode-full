# Conversation Share Revision 23 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the conversation-share client, service, and mock with backend API revision 23: slim confirm requests and two-hash preview/continuation integrity.

**Architecture:** Keep the UI and RPC contract unchanged. Split publish integrity from preparation idempotency: the confirm DTO contains only selected turns, public rows, two integrity hashes, and disclosure confirmation, while the service hashes that complete slim DTO separately for `preparation.payload_sha256`. The stateful mock reconstructs metadata and artifact descriptors from preparation/upload state before producing preview and continuation responses.

**Tech Stack:** TypeScript, Zod, Vitest, Node.js crypto, pnpm workspace.

## Global Constraints

- Follow backend document revision 23 and keep HTTP DTOs strict.
- `ConversationRow` fields stay camelCase; share-service fields stay snake_case.
- Confirm must not send `schema_version`, `client_request_id`, `title`, `access_mode`, `content_selection_id`, `artifacts`, or `integrity.payload_sha256`.
- Preview and Continuation integrity contain only `projection_sha256` and `artifact_set_sha256`.
- Preparation still receives a stable lower-case `payload_sha256` as an idempotency key.
- Do not change UI, conversation runtime state, desktop continuous delivery, or web remote replayable recovery.
- Preserve all unrelated dirty-worktree changes.
- Run `pnpm typecheck` and `pnpm lint` before completion.

---

### Task 1: Revision 23 shared contract

**Files:**
- Modify: `packages/shared/src/conversation-share.ts:121-217`
- Test: `packages/shared/test/conversationShareContract.test.ts:54-270`

**Interfaces:**
- Produces: `ConversationShareIntegrity` with exactly two hashes.
- Produces: `ConversationShareConfirmRequest` with exactly four top-level fields.
- Consumers: HTTP client, service integrity builder, mock transport, Preview and Continuation parsers.

- [x] **Step 1: Write failing contract tests**

Change the confirm fixture to the revision 23 body and assert the parsed key set:

```ts
const parsed = conversationShareConfirmRequestSchema.parse({
  selected_product_turn_ids: ["product-turn-1"],
  projection: { rows: completedRows },
  integrity: {
    projection_sha256: SHA_256,
    artifact_set_sha256: SHA_256,
  },
  disclosure_confirmation: {
    version: 1,
    accepted_at: 1_788_415_002_000,
    acknowledged_no_secret_detection: true,
  },
});

expect(Object.keys(parsed)).toEqual([
  "selected_product_turn_ids",
  "projection",
  "integrity",
  "disclosure_confirmation",
]);
```

Add an assertion that a legacy confirm body containing `payload_sha256` throws. Remove `payload_sha256` from Preview and Continuation fixtures and assert both parse successfully.

- [x] **Step 2: Run the contract test and verify RED**

Run: `pnpm exec vitest run packages/shared/test/conversationShareContract.test.ts`

Expected: FAIL because the current confirm schema requires legacy metadata/artifact fields and current response integrity requires `payload_sha256`.

- [x] **Step 3: Implement the strict shared schemas**

Change `conversationShareIntegritySchema` to:

```ts
export const conversationShareIntegritySchema = z
  .object({
    projection_sha256: conversationShareSha256Schema,
    artifact_set_sha256: conversationShareSha256Schema,
  })
  .strict();
```

Change `conversationShareConfirmRequestSchema` to the four allowed fields from the failing fixture. Keep Preview and Continuation using the two-hash integrity schema.

- [x] **Step 4: Run the contract test and verify GREEN**

Run: `pnpm exec vitest run packages/shared/test/conversationShareContract.test.ts`

Expected: PASS.

### Task 2: Slim confirm construction and preparation idempotency

**Files:**
- Modify: `packages/services/src/conversation-share/conversationShareIntegrity.ts:1-105`
- Modify: `packages/services/src/conversation-share/conversationShareService.ts:145-174`
- Test: `packages/services/test/conversationShareIntegrity.test.ts:55-104`
- Test: `packages/services/test/conversationShareService.test.ts:190-230`

**Interfaces:**
- Consumes: revision 23 `ConversationShareConfirmRequest` from Task 1.
- Produces: `buildConversationShareConfirmRequest(input)` returning the slim DTO.
- Produces: `sha256ConversationShareJson(confirmRequest)` passed only as `preparation.payload_sha256`.

- [x] **Step 1: Write failing integrity and service tests**

Replace the four-hash integrity test with assertions that the builder returns no legacy fields:

```ts
expect(request).toEqual({
  selected_product_turn_ids: ["product-turn-1"],
  projection: { rows },
  integrity: {
    projection_sha256: "7a748f1dac380029522841af7a40f7d33004368435c7e08a09c4a09c7592b7ba",
    artifact_set_sha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  },
  disclosure_confirmation,
});
```

In the service test, assert:

```ts
expect(confirmRequests[0]).not.toHaveProperty("payload_sha256");
expect(confirmRequests[0].integrity).not.toHaveProperty("payload_sha256");
expect(preparationRequests[0].payload_sha256).toBe(
  sha256ConversationShareJson(confirmRequests[0]),
);
```

Also assert preparation metadata still comes from `PublishTextConversationInput`, because it is no longer present on the confirm request.

- [x] **Step 2: Run focused tests and verify RED**

Run: `pnpm exec vitest run packages/services/test/conversationShareIntegrity.test.ts packages/services/test/conversationShareService.test.ts`

Expected: FAIL because the builder and service still use legacy confirm fields and read preparation metadata/hash from confirm.

- [x] **Step 3: Implement the minimal builder and service changes**

Define the builder input as the slim confirm fields plus a local-only artifact descriptor array:

```ts
type ConversationShareConfirmRequestBase = Omit<
  ConversationShareConfirmRequest,
  "integrity"
> & {
  artifacts: ConversationShareArtifactDescriptor[];
};
```

Compute `projection_sha256` from `projection.rows`, compute `artifact_set_sha256` from the sorted local-only artifacts, and return only the revision 23 confirm schema. In `ConversationShareService`, construct preparation with `input.clientRequestId`, `input.title.trim()`, `input.accessMode`, and `sha256ConversationShareJson(confirmRequest)`.

Add a Chinese comment at the service boundary explaining that revision 23 removed the hash from confirm and preparation now receives the independently calculated idempotency key.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm exec vitest run packages/services/test/conversationShareIntegrity.test.ts packages/services/test/conversationShareService.test.ts`

Expected: PASS.

### Task 3: HTTP serialization and stateful mock reconstruction

**Files:**
- Modify: `packages/services/src/conversation-share/conversationShareMockApiClient.ts:1-458`
- Test: `packages/services/test/conversationShareHttpClient.test.ts:102-227`
- Test: `packages/services/test/conversationShareMockApiClient.test.ts:1-330`

**Interfaces:**
- Consumes: slim confirm DTO and two-hash integrity from Tasks 1-2.
- Produces: Mock Preview/Continuation responses whose metadata comes from preparation and whose artifact list comes from successful uploads.

- [x] **Step 1: Write failing HTTP and Mock tests**

Update the HTTP logging/serialization fixture to the slim body and assert the serialized body equals it exactly. In Mock lifecycle tests, assert Preview and Continuation integrity contain exactly:

```ts
expect(Object.keys(preview.integrity).sort()).toEqual([
  "artifact_set_sha256",
  "projection_sha256",
]);
```

Add a strict rejection test showing that a legacy confirm body with `payload_sha256` returns code `3001`. Keep the existing upload-incomplete and invalid-public-row cases, but construct their preparation hash with `sha256ConversationShareJson(confirmRequest)`.

- [x] **Step 2: Run focused tests and verify RED**

Run: `pnpm exec vitest run packages/services/test/conversationShareHttpClient.test.ts packages/services/test/conversationShareMockApiClient.test.ts`

Expected: FAIL because the Mock still reads metadata, artifacts, and payload hash from confirm.

- [x] **Step 3: Implement Mock reconstruction**

Store `accessMode`, `title`, and sorted uploaded artifacts on `StoredShare` separately from the slim confirm request:

```ts
interface StoredShare {
  shareId: string;
  shareCode: string;
  ownerToken: string;
  createdAt: number;
  expiresAt: number;
  title: string;
  accessMode: ConversationShareAccessMode;
  artifacts: ConversationShareArtifactDescriptor[];
  request: ConversationShareConfirmRequest;
}
```

In confirm, require `preparation.uploads.size === preparation.request.artifact_count`, sort the uploaded descriptors by `artifact_id`, rebuild the expected two hashes with `buildConversationShareConfirmRequest`, and compare only those hashes. Build response metadata from preparation and artifact responses from `StoredShare.artifacts`.

Add a Chinese comment explaining that revision 23 intentionally removes preparation metadata and artifact descriptors from confirm, so the Mock must reconstruct them like the backend.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm exec vitest run packages/services/test/conversationShareHttpClient.test.ts packages/services/test/conversationShareMockApiClient.test.ts`

Expected: PASS.

### Task 4: Affected-suite and mechanical verification

**Files:**
- Verify: `packages/shared/test/conversationShareContract.test.ts`
- Verify: `packages/services/test/conversationShare*.test.ts`
- Verify: `docs/superpowers/specs/2026-08-10-conversation-share-api-integration-design.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified revision 23 implementation with no unrelated changes staged.

- [x] **Step 1: Run all conversation-share tests**

Run: `pnpm exec vitest run packages/shared/test/conversationShareContract.test.ts packages/services/test/conversationSharePublicProjection.test.ts packages/services/test/conversationShareService.test.ts packages/services/test/conversationShareHttpClient.test.ts packages/services/test/conversationShareIntegrity.test.ts packages/services/test/conversationShareComposition.test.ts packages/services/test/conversationShareMockApiClient.test.ts`

Expected: all files and tests PASS.

- [x] **Step 2: Run mandatory repository checks**

Run: `pnpm typecheck`

Expected: exit code 0.

Run: `pnpm lint`

Expected: exit code 0 with no new warnings attributable to changed files.

- [x] **Step 3: Inspect the final diff**

Run: `git diff --check`

Run: `git diff -- docs/superpowers/plans/2026-08-11-conversation-share-revision-23.md packages/shared/src/conversation-share.ts packages/shared/test/conversationShareContract.test.ts packages/services/src/conversation-share/conversationShareIntegrity.ts packages/services/src/conversation-share/conversationShareService.ts packages/services/src/conversation-share/conversationShareMockApiClient.ts packages/services/test/conversationShareIntegrity.test.ts packages/services/test/conversationShareService.test.ts packages/services/test/conversationShareHttpClient.test.ts packages/services/test/conversationShareMockApiClient.test.ts`

Expected: only revision 23 contract, hash, mock, tests, and this plan are present.

- [x] **Step 4: Commit the implementation**

```bash
git add docs/superpowers/plans/2026-08-11-conversation-share-revision-23.md packages/shared/src/conversation-share.ts packages/shared/test/conversationShareContract.test.ts packages/services/src/conversation-share/conversationShareIntegrity.ts packages/services/src/conversation-share/conversationShareService.ts packages/services/src/conversation-share/conversationShareMockApiClient.ts packages/services/test/conversationShareIntegrity.test.ts packages/services/test/conversationShareService.test.ts packages/services/test/conversationShareHttpClient.test.ts packages/services/test/conversationShareMockApiClient.test.ts
git commit -m "fix(conversation-share): align revision 23 confirm contract"
```
