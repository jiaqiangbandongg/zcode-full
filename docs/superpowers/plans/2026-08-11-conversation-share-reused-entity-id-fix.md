# Conversation Share Reused Entity ID Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 允许公开会话投影中的多个 Row 复用同一个持久 `entityId`，避免发布在调用 prepare 前被客户端误判为非法会话。

**Architecture:** 保持现有公开投影映射器与引用闭包边界不变，只纠正断言语义：`rowId` 与 `toolCallId` 唯一，`entityId` 是可跨 Row 复用的持久实体身份。构建器继续将同一个本地 `entityId` 确定性映射为同一个公开 ID，并通过去重集合验证 `triggerEntityId` 引用闭包。

**Tech Stack:** TypeScript、Vitest、pnpm、Oxlint

## Global Constraints

- 先写会失败的回归测试，再修改生产代码。
- 不修改 UI、RPC、HTTP API、后端 payload schema 或 realtime delivery。
- 修复原因必须留在生产代码的中文注释中。
- 完成前必须执行 `pnpm typecheck` 与 `pnpm lint`。

---

### Task 1: Correct public entity identity validation

**Files:**

- Modify: `packages/services/test/conversationSharePublicProjection.test.ts`
- Modify: `packages/services/src/conversation-share/conversationSharePublicProjection.ts`

**Interfaces:**

- Consumes: `buildConversationSharePublicProjection({ rows, selectedProductTurnIds })`
- Produces: 允许多个公开 Row 共享同一个格式合法的 `entityId`，并继续拒绝悬空的 `triggerEntityId`

- [ ] **Step 1: Write the failing regression test**

在现有 fixture 中让 `turnHeader` 与 `userInput` 使用同一个本地实体身份，并断言构建成功后两行都映射为字面量 `share-entity-1`：

```ts
it("allows rows to share one persistent entity identity", () => {
  const rows = rowsWithCompletedSubagent();
  rows[1] = { ...rows[1]!, entityId: rows[0]!.entityId } as ConversationRow;

  const result = build(rows);

  expect(result.rows[0]?.entityId).toBe("share-entity-1");
  expect(result.rows[1]?.entityId).toBe("share-entity-1");
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm exec vitest run packages/services/test/conversationSharePublicProjection.test.ts
```

Expected: FAIL with `Conversation public entity identities must be unique` from `assertConversationSharePublicProjection`.

- [ ] **Step 3: Implement the minimal validation correction**

将验证器的实体集合改为 `Set<string>`；验证格式后将 `entityId` 加入集合，不再调用实体唯一性断言。保留 `toolCallId` 唯一性断言，并直接用实体集合验证每个 `triggerEntityId`。

```ts
const entityIds = new Set<string>();

if (row.entityId) {
  if (!PUBLIC_ENTITY_ID.test(row.entityId)) {
    throwProjectionError("invalid_conversation", "Conversation public entity identity is invalid");
  }
  // entityId 是持久实体身份，一个实体可以投影成多个 Row；这里只收集引用闭包，不校验 Row 间唯一性。
  entityIds.add(row.entityId);
}
```

- [ ] **Step 4: Verify focused and related tests GREEN**

Run:

```bash
pnpm exec vitest run packages/services/test/conversationSharePublicProjection.test.ts packages/services/test/conversationShareService.test.ts packages/services/test/conversationShareHttpClient.test.ts packages/services/test/conversationShareIntegrity.test.ts packages/services/test/conversationShareComposition.test.ts packages/services/test/conversationShareMockApiClient.test.ts
```

Expected: all selected test files pass.

- [ ] **Step 5: Run required repository checks**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both commands exit with code 0; pre-existing lint warnings may remain unchanged.

- [ ] **Step 6: Commit the fix**

```bash
git add docs/superpowers/specs/2026-08-10-conversation-share-api-integration-design.md docs/superpowers/plans/2026-08-11-conversation-share-reused-entity-id-fix.md packages/services/test/conversationSharePublicProjection.test.ts packages/services/src/conversation-share/conversationSharePublicProjection.ts
git commit -m "fix(conversation-share): allow reused entity identities"
```
