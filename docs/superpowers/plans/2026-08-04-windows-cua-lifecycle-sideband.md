# Windows CUA Lifecycle Sideband Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Windows CUA 顶部提示从 CLI runtime 的真实工具生命周期获得状态，不再依赖当前 v4 桌面对话不会发送的旧 `session/event`。

**Architecture:** CLI 在原始 `SessionEvent` 进入协议投影时额外发送严格、精简、不可重放的 `computer-use/operation-event` 通知；通知与 v4 conversation frame 并行，且位于 `record.deliveryKind` 判断之前。Services 只用该通知驱动 `CuaOperationTurnTracker`，再沿既有 Host→Main `cua-operation-state` 链路显示浮层；旧 `session/event`、Renderer、snapshot 和 relay 都不拥有提示状态。

**Tech Stack:** TypeScript 6、Zod、Vitest 4、ZCode Protocol NDJSON、Electron UtilityProcess/BrowserWindow、pnpm。

## Global Constraints

- 先修改测试并观察预期失败，再写最小实现；不得先改生产代码。
- App ↔ Agent 新协议必须定义在 `packages/shared/src/zcode-protocol/index.ts`，使用严格 runtime schema。
- method 固定为 `computer-use/operation-event`；官方身份只接受 `computer-use` 中划线形式，不新增 `computer_use`。
- 通知只携带 lifecycle 元数据，不携带 tool input/result、模型文本、截图或用户内容。
- 通知不受旧 `session/event` 的 `deliveryKind` 或 v4 subscription 状态影响，不进入 snapshot/replayable/v4 topic/relay。
- tracker 只消费 sideband 的 runtime `sequenceNumber`，不与旧协议 `seq` 混用。
- Windows desktop-local reporter 行为保持不变；remote workspace/server/Web 不新增浮层，手机 shared-host 仅复用本机 Host。
- UI、Desktop Main 浮层视觉、capture exclusion、焦点和多窗口聚合行为保持不变。
- 高频生命周期诊断走 `debug`；状态跃迁走 `info`；旁路异常不能阻断 v4 frame 或工具执行。
- 最终必须执行定向测试、`pnpm typecheck`、`pnpm lint`、`git diff --check`，并提交 Conventional Commit；不得 push。

---

## File Structure

- Modify `packages/shared/src/zcode-protocol/index.ts`: 定义 sideband method、严格判别联合 schema 和导出类型。
- Modify `packages/shared/test/zcodeProtocol.test.ts`: 验证 method、六类 payload、严格字段和非法输入。
- Create `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/computer-use-operation-event.ts`: 将 runtime `SessionEvent` 投影为最小 sideband payload。
- Modify `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`: 在 v4/legacy 分流之前 best-effort 发送 sideband。
- Modify `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`: 验证无 `deliveryKind` 仍发送、无敏感 payload、发送失败不阻断 v4。
- Modify `packages/services/src/zcode-agent/cuaOperationTurnTracker.ts`: 改为消费 sideband 类型并按 `eventId`/`sequenceNumber` 去重。
- Modify `packages/services/test/cuaOperationTurnTracker.test.ts`: 将 fixture 和全部状态机断言迁移到 sideband 生命周期。
- Modify `packages/services/src/zcode-agent/zcodeAgentService.ts`: 新增 sideband notification 分支，移除旧 `session/event` 对 tracker 的驱动。
- Modify `packages/services/test/zcodeAgentService.test.ts`: fake agent 只发 sideband，验证 reporter 跃迁且普通 session 流不受影响。
- Modify `docs/product-capability-map-office-computer-use.md`: 更新真实状态链。
- Modify `apps/dev-docs/src/data/productCapabilityMap.ts`: 更新能力图 producer/consumer 描述。
- Modify `apps/dev-docs/test/capabilityMapOfficeComputerUse.test.ts`: 固化 sideband 状态链。

---

### Task 1: Strict App ↔ Agent Lifecycle Contract

**Files:**

- Modify: `packages/shared/src/zcode-protocol/index.ts`
- Test: `packages/shared/test/zcodeProtocol.test.ts`

**Interfaces:**

- Produces: `zcodeProtocolMethods.computerUseOperationEvent === "computer-use/operation-event"`
- Produces: `zcodeComputerUseOperationEventSchema`
- Produces: `ZCodeComputerUseOperationEvent`

- [ ] **Step 1: Write failing protocol contract tests**

Import the new schema and assert exact method naming plus one valid payload for every kind:

```ts
expect(zcodeProtocolMethods.computerUseOperationEvent).toBe("computer-use/operation-event");

const base = {
  eventId: "evt-1",
  sequenceNumber: 1,
  sessionId: "sess-1",
  timestamp: 1_700_000_000_000,
};

for (const event of [
  { ...base, kind: "turn-started", turnId: "turn-1" },
  { ...base, kind: "turn-completed", turnId: "turn-1" },
  { ...base, kind: "turn-failed", turnId: "turn-1" },
  {
    ...base,
    kind: "tool-scheduled",
    turnId: "turn-1",
    toolCallId: "call-1",
    toolName: "mcp__computer-use__left_click",
  },
  {
    ...base,
    kind: "tool-started",
    turnId: "turn-1",
    toolCallId: "call-1",
  },
  { ...base, kind: "session-closed" },
]) {
  expect(zcodeComputerUseOperationEventSchema.safeParse(event).success).toBe(true);
}
```

Add table cases rejecting empty ids, negative `sequenceNumber`, missing turn/tool fields, `toolName` on an incompatible kind, unknown keys and unknown kinds.

- [ ] **Step 2: Run RED**

Run: `pnpm exec vitest run packages/shared/test/zcodeProtocol.test.ts`

Expected: FAIL because the method and schema exports do not exist.

- [ ] **Step 3: Add the minimal strict schema**

Define a shared strict base and discriminated union:

```ts
const zcodeComputerUseOperationEventBaseSchema = z.object({
  eventId: nonEmptyString,
  sequenceNumber: z.number().int().nonnegative(),
  sessionId: nonEmptyString,
  timestamp: timestampMsSchema,
});

export const zcodeComputerUseOperationEventSchema = z.discriminatedUnion("kind", [
  ...["turn-started", "turn-completed", "turn-failed"].map((kind) =>
    zcodeComputerUseOperationEventBaseSchema
      .extend({
        kind: z.literal(kind),
        turnId: nonEmptyString,
      })
      .strict(),
  ),
  zcodeComputerUseOperationEventBaseSchema
    .extend({
      kind: z.literal("tool-scheduled"),
      turnId: nonEmptyString,
      toolCallId: nonEmptyString,
      toolName: nonEmptyString,
    })
    .strict(),
  zcodeComputerUseOperationEventBaseSchema
    .extend({
      kind: z.literal("tool-started"),
      turnId: nonEmptyString.optional(),
      toolCallId: nonEmptyString,
      toolName: nonEmptyString.optional(),
    })
    .strict(),
  zcodeComputerUseOperationEventBaseSchema
    .extend({
      kind: z.literal("session-closed"),
    })
    .strict(),
]);
```

Use explicit schema declarations instead of `.map()` if TypeScript cannot preserve the Zod tuple type. Export the inferred type and add the method constant.

- [ ] **Step 4: Run GREEN**

Run: `pnpm exec vitest run packages/shared/test/zcodeProtocol.test.ts`

Expected: PASS with zero failures.

---

### Task 2: CLI Runtime Event Sideband

**Files:**

- Create: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/computer-use-operation-event.ts`
- Modify: `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`
- Test: `apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts`

**Interfaces:**

- Consumes: `SessionEvent`
- Produces: `mapComputerUseOperationEvent(event): ZCodeComputerUseOperationEvent | undefined`
- Emits: `{ method: zcodeProtocolMethods.computerUseOperationEvent, params }`

- [ ] **Step 1: Write failing CLI projection and delivery tests**

Add a test that builds a record without `deliveryKind`, passes `TurnStarted`, `ToolCallScheduled`, `ToolCallStarted`, `ToolCallResult`, `TurnComplete` and `SessionEnded` through `onSessionEvent`, and asserts:

```ts
expect(notify.mock.calls.map(([message]) => message.method)).toEqual([
  "computer-use/operation-event",
  "computer-use/operation-event",
  "computer-use/operation-event",
  "computer-use/operation-event",
  "computer-use/operation-event",
]);
expect(notify.mock.calls.map(([message]) => message.params.kind)).toEqual([
  "turn-started",
  "tool-scheduled",
  "tool-started",
  "turn-completed",
  "session-closed",
]);
expect(notify.mock.calls[1]?.[0].params).not.toHaveProperty("input");
expect(notify.mock.calls[2]?.[0].params).not.toHaveProperty("result");
```

Assert `v4Gateway.ingest` still receives every parent-session event. Add a separate test whose `notify` throws for a relevant event and assert `onSessionEvent` does not throw and `v4Gateway.ingest` still runs.

- [ ] **Step 2: Run RED**

Run: `pnpm --dir apps/zcode-cli exec vitest run packages/bootstrap/tests/zcode-protocol.test.ts`

Expected: FAIL because no sideband is emitted.

- [ ] **Step 3: Implement the pure mapper**

Create a switch over `SessionEventType` that copies only `id`, `sequenceNumber`, `sessionId`, `turnId`, `timestamp`, `toolCallId` and `toolName`. Return `undefined` for all other events. Add a Chinese bug-cause comment explaining that the v4 desktop path has no legacy `deliveryKind`, so the overlay lifecycle must be emitted before that gate.

- [ ] **Step 4: Wire best-effort notification before protocol projection gates**

At the top of `onSessionEvent`, before the child-session return and before `record.deliveryKind`, call a helper:

```ts
const operationEvent = mapComputerUseOperationEvent(event);
if (operationEvent) {
  try {
    context.notify({
      method: zcodeProtocolMethods.computerUseOperationEvent,
      params: operationEvent,
    });
  } catch (error) {
    context.logger?.warn("Computer Use operation lifecycle notification failed", {
      event: "zcode_protocol.computer_use_operation_event.failed",
      eventId: operationEvent.eventId,
      sessionId: operationEvent.sessionId,
      turnId: "turnId" in operationEvent ? operationEvent.turnId : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
```

The log event identifier may use underscores as a logger key, but method/tool identity must stay `computer-use`. Do not return from the catch.

- [ ] **Step 5: Run GREEN**

Run: `pnpm --dir apps/zcode-cli exec vitest run packages/bootstrap/tests/zcode-protocol.test.ts`

Expected: PASS with zero failures.

---

### Task 3: Services Tracker and Notification Wiring

**Files:**

- Modify: `packages/services/src/zcode-agent/cuaOperationTurnTracker.ts`
- Modify: `packages/services/test/cuaOperationTurnTracker.test.ts`
- Modify: `packages/services/src/zcode-agent/zcodeAgentService.ts`
- Modify: `packages/services/test/zcodeAgentService.test.ts`

**Interfaces:**

- `CuaOperationTurnTracker.accept(workspace, event: ZCodeComputerUseOperationEvent): void`
- `ZCodeAgentService.wireClient` consumes `zcodeProtocolMethods.computerUseOperationEvent`

- [ ] **Step 1: Migrate tracker tests to the new event contract**

Replace `ZCodeSessionEvent` fixtures with sideband fixtures using `kind`, `sequenceNumber` and `eventId`. Preserve every existing activation, exclusion, terminal, workspace isolation and reporter-failure assertion. Remove result/error fixture delivery because the sideband deliberately omits them; retain the assertion that state stays active until a turn terminal.

Add an explicit duplicate-id test:

```ts
const started = operationEvent("tool-started", {
  turnId: "turn-1",
  toolCallId: "call-1",
  toolName: "mcp__computer-use__left_click",
});
tracker.accept(workspace, started);
tracker.accept(workspace, started);
expect(states).toHaveLength(1);
```

- [ ] **Step 2: Run tracker RED**

Run: `pnpm exec vitest run packages/services/test/cuaOperationTurnTracker.test.ts`

Expected: FAIL because `accept` still expects legacy `ZCodeSessionEvent` kinds.

- [ ] **Step 3: Implement the minimal sideband state machine adaptation**

Import `ZCodeComputerUseOperationEvent`, replace `seq` with `sequenceNumber`, add a bounded `seenEventIds` set/order, and switch on the new kinds. Keep all existing canonical tool matching, non-operating actions, stop behavior, retired-turn protection, reporter isolation and workspace cleanup. Add a Chinese bug-cause comment explaining why legacy `session/event` and sideband sequence domains must not be mixed.

- [ ] **Step 4: Run tracker GREEN**

Run: `pnpm exec vitest run packages/services/test/cuaOperationTurnTracker.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 5: Change the service integration fake to sideband-only and observe RED**

Update `CUA_OPERATION_LIVE_EVENT_FAKE_AGENT` so it sends strict `computer-use/operation-event` notifications after the existing subscribe ACK, but sends no `session/event`. Assert reporter states are `[true, false]`, invalid payload is ignored, duplicate `eventId` is idempotent, and received legacy session events remain empty.

Run: `pnpm exec vitest run packages/services/test/zcodeAgentService.test.ts`

Expected: FAIL because `wireClient` ignores the new notification.

- [ ] **Step 6: Wire the strict notification and detach tracker from legacy events**

In `wireClient`, before generic state/interaction branches:

```ts
if (message.method === zcodeProtocolMethods.computerUseOperationEvent) {
  const parsed = zcodeComputerUseOperationEventSchema.safeParse(message.params);
  if (parsed.success) {
    cuaOperationTurnTracker?.accept(workspace, parsed.data);
  } else {
    logger.warn(undefined, "丢弃无效 Computer Use operation event", {
      issues: parsed.error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path.join("."),
      })),
      workspaceKey: resolveWorkspaceKey(workspace),
    });
  }
  return;
}
```

Remove `cuaOperationTurnTracker?.accept(workspace, normalizedEvent)` from `handleSessionEvent`. Do not alter ordinary `session.event` emission or v4 frame forwarding.

- [ ] **Step 7: Run services GREEN**

Run:

```powershell
pnpm exec vitest run packages/services/test/cuaOperationTurnTracker.test.ts packages/services/test/zcodeAgentService.test.ts packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts
```

Expected: PASS with zero failures.

---

### Task 4: Capability Truth and Full Verification

**Files:**

- Modify: `docs/product-capability-map-office-computer-use.md`
- Modify: `apps/dev-docs/src/data/productCapabilityMap.ts`
- Modify: `apps/dev-docs/test/capabilityMapOfficeComputerUse.test.ts`
- Review: all files above plus `docs/superpowers/specs/2026-08-04-windows-cua-operation-indicator-design.md`

**Interfaces:**

- Documents the chain `CLI runtime lifecycle -> computer-use/operation-event -> desktop-local Host tracker -> cua-operation-state -> Desktop Main overlay`.

- [ ] **Step 1: Write the failing capability graph assertion**

Require the current Computer Use experience node/edge text to include `computer-use/operation-event` and the CLI lifecycle source rather than `validated live session event`.

- [ ] **Step 2: Run RED**

Run: `pnpm exec vitest run apps/dev-docs/test/capabilityMapOfficeComputerUse.test.ts`

Expected: FAIL because capability truth still names the old source.

- [ ] **Step 3: Update capability truth**

Change only the current source/edge wording; preserve that live video, pause and takeover remain planned. Update the document ASCII chain to:

```text
CLI runtime lifecycle
        -> computer-use/operation-event
        -> desktop-local Host turn tracker
        -> strict Host→Main cua-operation-state
        -> capture-excluded Windows BrowserWindow
```

- [ ] **Step 4: Run the focused suite**

Run:

```powershell
pnpm exec vitest run packages/shared/test/zcodeProtocol.test.ts packages/services/test/cuaOperationTurnTracker.test.ts packages/services/test/zcodeAgentService.test.ts packages/services/test/cuaPermissionBrokerProductAgentEnv.test.ts packages/desktop/test/desktopHostProcess.test.ts packages/desktop/test/windowsCuaOperationIndicator.test.ts apps/dev-docs/test/capabilityMapOfficeComputerUse.test.ts
pnpm --dir apps/zcode-cli exec vitest run packages/bootstrap/tests/zcode-protocol.test.ts
```

Expected: both commands pass with zero failed tests.

- [ ] **Step 5: Run repository gates**

Run:

```powershell
git diff --check
pnpm typecheck
pnpm lint
```

Expected: every command exits 0. Any failure introduced by this change blocks commit; pre-existing unrelated failures must be reported with exact evidence.

- [ ] **Step 6: Review invariants and commit**

Verify:

```powershell
git status --short
git diff --stat
rg -n -- "computer_use" packages/shared/src/zcode-protocol apps/zcode-cli/packages/bootstrap/src/zcode-protocol packages/services/src/zcode-agent
```

Confirm no new `computer_use` tool/method identity was introduced, `.tmp/` and unrelated user files are not staged, and the final diff matches the approved spec. Then commit only scoped files:

```powershell
git add -- packages/shared/src/zcode-protocol/index.ts packages/shared/test/zcodeProtocol.test.ts apps/zcode-cli/packages/bootstrap/src/zcode-protocol/computer-use-operation-event.ts apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts apps/zcode-cli/packages/bootstrap/tests/zcode-protocol.test.ts packages/services/src/zcode-agent/cuaOperationTurnTracker.ts packages/services/src/zcode-agent/zcodeAgentService.ts packages/services/test/cuaOperationTurnTracker.test.ts packages/services/test/zcodeAgentService.test.ts apps/dev-docs/src/data/productCapabilityMap.ts apps/dev-docs/test/capabilityMapOfficeComputerUse.test.ts docs/product-capability-map-office-computer-use.md docs/superpowers/plans/2026-08-04-windows-cua-lifecycle-sideband.md
git diff --cached --check
git commit -m "fix(cua): drive Windows indicator from runtime lifecycle"
```

Expected: one Conventional Commit, no push.
