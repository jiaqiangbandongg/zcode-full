import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  type EventId,
  type SessionEvent,
  type SessionEventType as SessionEventTypeUnion,
  type SessionId,
  type TraceId,
  type TurnId,
} from "@zcode/contracts";
import {
  applyConversationDeltas,
  type ConversationDelta,
  type ConversationSnapshot,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

const SESSION_ID = "open-tool-index-session";

interface ProductProjectionOpenToolInternals {
  snapshot: ConversationSnapshot;
  openForegroundToolCallIds: Set<string>;
  toolRowIdByCallId: Map<string, number>;
  closeOpenToolRows(event: SessionEvent, status: "cancelled" | "error"): ConversationDelta[];
  updateToolIndexesAfterDeltas(deltas: readonly ConversationDelta[]): void;
}

class ProjectionHarness {
  readonly projection: ProductProjection;
  private sequenceNumber = 0;

  constructor(epoch: string) {
    this.projection = new ProductProjection(SESSION_ID, epoch);
    this.apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200_000 });
  }

  get internals(): ProductProjectionOpenToolInternals {
    return projectionInternals(this.projection);
  }

  event(type: SessionEventTypeUnion, payload: unknown, turnId?: string): SessionEvent {
    this.sequenceNumber += 1;
    return {
      id: `open-tool-event-${this.sequenceNumber}` as EventId,
      sessionId: SESSION_ID as SessionId,
      ...(turnId ? { turnId: turnId as TurnId } : {}),
      type,
      timestamp: new Date(1_700_000_000_000 + this.sequenceNumber),
      traceId: "open-tool-trace" as TraceId,
      sequenceNumber: this.sequenceNumber,
      payload,
    };
  }

  apply(type: SessionEventTypeUnion, payload: unknown, turnId?: string): SessionEvent {
    const event = this.event(type, payload, turnId);
    this.projection.applyEvent(event);
    return event;
  }

  startTurn(turnId: string, turnNumber: number, messageId = `user-${turnNumber}`): void {
    this.apply(
      SessionEventType.TurnStarted,
      { turnNumber, input: `turn ${turnNumber}`, messageId },
      turnId,
    );
  }

  scheduleTool(turnId: string, toolCallId: string): void {
    this.apply(
      SessionEventType.ToolCallScheduled,
      {
        toolCallId,
        toolName: "Bash",
        input: { command: "pwd" },
        schedule: { parallelGroups: [[toolCallId]], executionOrder: [toolCallId] },
      },
      turnId,
    );
  }

  toolRow(toolCallId: string): ToolCallRow {
    const row = this.projection
      .getSnapshot()
      .rows.window.find(
        (candidate): candidate is ToolCallRow =>
          candidate.kind === "toolCall" && candidate.toolCallId === toolCallId,
      );
    if (!row) throw new Error(`missing tool row ${toolCallId}`);
    return row;
  }

  completeTurn(turnId: string, resultType: "success" | "cancelled" = "success"): void {
    this.apply(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 1, duration: 1, resultType },
      turnId,
    );
  }
}

function projectionInternals(projection: ProductProjection): ProductProjectionOpenToolInternals {
  return projection as unknown as ProductProjectionOpenToolInternals;
}

describe("ProductProjection open foreground tool index", () => {
  it("TurnComplete 只遍历 open tracker，不枚举完整 rows 窗口", () => {
    const harness = new ProjectionHarness("epoch-scan");
    harness.startTurn("turn-scan", 1);
    harness.scheduleTool("turn-scan", "tool-scan");

    const internals = harness.internals;
    expect([...internals.openForegroundToolCallIds]).toEqual(["tool-scan"]);
    const originalSnapshot = internals.snapshot;
    internals.snapshot = {
      ...originalSnapshot,
      rows: {
        ...originalSnapshot.rows,
        window: new Proxy(originalSnapshot.rows.window, {
          get(target, property, receiver) {
            if (property === Symbol.iterator) {
              throw new Error("closeOpenToolRows must not enumerate the rows window");
            }
            return Reflect.get(target, property, receiver);
          },
        }),
      },
    };

    try {
      const deltas = internals.closeOpenToolRows(
        harness.event(
          SessionEventType.TurnComplete,
          { response: "", tokenCount: 0, toolCallCount: 1, duration: 1, resultType: "success" },
          "turn-scan",
        ),
        "error",
      );
      expect(deltas).toEqual([
        expect.objectContaining({
          op: "row.upserted",
          row: expect.objectContaining({ toolCallId: "tool-scan", status: "error" }),
        }),
      ]);
    } finally {
      internals.snapshot = originalSnapshot;
    }
  });

  it("缺 terminal 的 permission tool 被收口，迟到 allow 重新打开后仍会再次收口", () => {
    const harness = new ProjectionHarness("epoch-reopen");
    harness.startTurn("turn-1", 1);
    harness.scheduleTool("turn-1", "tool-reopen");
    harness.apply(
      SessionEventType.PermissionRequested,
      {
        requestId: "permission-reopen",
        toolCallId: "tool-reopen",
        toolName: "Bash",
        riskLevel: "medium",
        reason: "Run command",
        input: { command: "pwd" },
      },
      "turn-1",
    );

    expect(harness.projection.getSnapshot().pendingInteractions).toHaveLength(1);
    harness.completeTurn("turn-1");
    expect(harness.toolRow("tool-reopen")).toMatchObject({
      status: "error",
      error: { code: "fault.runtime.toolLifecycleIncomplete" },
    });
    expect(harness.projection.getSnapshot().pendingInteractions).toEqual([]);
    expect(harness.internals.openForegroundToolCallIds.size).toBe(0);

    harness.startTurn("turn-2", 2);
    harness.apply(
      SessionEventType.PermissionResolved,
      { requestId: "permission-reopen", toolCallId: "tool-reopen", decision: "allow" },
      "turn-1",
    );
    expect(harness.toolRow("tool-reopen").status).toBe("running");
    expect([...harness.internals.openForegroundToolCallIds]).toEqual(["tool-reopen"]);

    harness.completeTurn("turn-2");
    expect(harness.toolRow("tool-reopen").status).toBe("error");
    expect(harness.internals.openForegroundToolCallIds.size).toBe(0);
  });

  it("多个旧 tool 逆序 reopen 后仍按 snapshot row 顺序下发收口 delta", () => {
    const harness = new ProjectionHarness("epoch-reopen-order");
    harness.startTurn("turn-order-1", 1);
    harness.scheduleTool("turn-order-1", "tool-order-a");
    harness.scheduleTool("turn-order-1", "tool-order-b");
    harness.completeTurn("turn-order-1");

    harness.startTurn("turn-order-2", 2);
    for (const toolCallId of ["tool-order-b", "tool-order-a"]) {
      harness.apply(
        SessionEventType.ToolCallStarted,
        { toolCallId, toolName: "Bash", startedAt: new Date() },
        "turn-order-1",
      );
    }
    const terminal = harness.event(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 2, duration: 1, resultType: "success" },
      "turn-order-2",
    );
    const closedToolCallIds = harness.projection
      .applyEvent(terminal)
      .flatMap((delta) =>
        delta.op === "row.upserted" && delta.row.kind === "toolCall" ? [delta.row.toolCallId] : [],
      );

    expect(closedToolCallIds).toEqual(["tool-order-a", "tool-order-b"]);
  });

  it.each([
    { terminal: "cancelled" as const, expectedStatus: "cancelled" as const },
    { terminal: "error" as const, expectedStatus: "error" as const },
  ])("$terminal turn 正确收口 tracker 中的 foreground tool", ({ terminal, expectedStatus }) => {
    const harness = new ProjectionHarness(`epoch-${terminal}`);
    harness.startTurn(`turn-${terminal}`, 1);
    harness.scheduleTool(`turn-${terminal}`, `tool-${terminal}`);

    if (terminal === "cancelled") {
      harness.completeTurn(`turn-${terminal}`, "cancelled");
    } else {
      harness.apply(
        SessionEventType.TurnError,
        { error: { type: "ProviderError", message: "failed" }, turnPhase: "model" },
        `turn-${terminal}`,
      );
    }

    expect(harness.toolRow(`tool-${terminal}`).status).toBe(expectedStatus);
    expect(harness.internals.openForegroundToolCallIds.size).toBe(0);
  });

  it("backgrounded tool 不进入 tracker，也不会被 turn terminal 收口", () => {
    const harness = new ProjectionHarness("epoch-background");
    harness.startTurn("turn-background", 1);
    harness.scheduleTool("turn-background", "tool-background");

    const internals = harness.internals;
    const backgrounded: ToolCallRow = {
      ...harness.toolRow("tool-background"),
      backgrounded: true,
      workId: "work-background",
    };
    const delta: ConversationDelta = { op: "row.upserted", row: backgrounded };
    internals.snapshot = applyConversationDeltas(internals.snapshot, [delta]);
    internals.updateToolIndexesAfterDeltas([delta]);

    expect(internals.openForegroundToolCallIds.size).toBe(0);
    expect(
      internals.closeOpenToolRows(
        harness.event(
          SessionEventType.TurnComplete,
          { response: "", tokenCount: 0, toolCallCount: 1, duration: 1, resultType: "success" },
          "turn-background",
        ),
        "error",
      ),
    ).toEqual([]);
    expect(harness.toolRow("tool-background")).toMatchObject({
      status: "inputStreaming",
      backgrounded: true,
    });
  });

  it("rewind 清理 open/tool 索引，同 toolCallId 可在新分支重新打开并收口", () => {
    const harness = new ProjectionHarness("epoch-rewind");
    harness.startTurn("turn-old", 1, "message-old");
    harness.apply(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_start",
        delta: "",
        done: false,
        toolCallId: "tool-reused",
        toolName: "Bash",
      },
      "turn-old",
    );
    expect([...harness.internals.openForegroundToolCallIds]).toEqual(["tool-reused"]);

    harness.apply(SessionEventType.RewindTriggered, {
      targetMessageId: "message-old",
      scope: "conversation",
      createdMessageId: "rewind-applied",
    });
    expect(harness.projection.getSnapshot().rows.window).toEqual([]);
    expect(harness.internals.openForegroundToolCallIds.size).toBe(0);
    expect(harness.internals.toolRowIdByCallId.has("tool-reused")).toBe(false);

    harness.startTurn("turn-new", 2, "message-new");
    harness.apply(
      SessionEventType.ModelStreaming,
      {
        kind: "tool_input_start",
        delta: "",
        done: false,
        toolCallId: "tool-reused",
        toolName: "Bash",
      },
      "turn-new",
    );
    expect(harness.toolRow("tool-reused").status).toBe("inputStreaming");
    expect([...harness.internals.openForegroundToolCallIds]).toEqual(["tool-reused"]);

    harness.completeTurn("turn-new", "cancelled");
    expect(harness.toolRow("tool-reused").status).toBe("cancelled");
    expect(harness.internals.openForegroundToolCallIds.size).toBe(0);
  });

  it("atomic reject 不泄漏 tracker，accept 后随候选状态一起 adopt", () => {
    const harness = new ProjectionHarness("epoch-atomic");
    harness.startTurn("turn-atomic", 1);
    harness.scheduleTool("turn-atomic", "tool-atomic");
    const before = structuredClone(harness.projection.getSnapshot());
    const result = harness.event(
      SessionEventType.ToolCallResult,
      { toolCallId: "tool-atomic", result: { success: true, content: "ok" }, duration: 1 },
      "turn-atomic",
    );

    expect(harness.projection.applyEventAtomically(result, () => false)).toBeNull();
    expect(harness.projection.getSnapshot()).toEqual(before);
    expect([...harness.internals.openForegroundToolCallIds]).toEqual(["tool-atomic"]);

    expect(harness.projection.applyEventAtomically(result, () => true)).not.toBeNull();
    expect(harness.toolRow("tool-atomic").status).toBe("success");
    expect(harness.internals.openForegroundToolCallIds.size).toBe(0);
  });

  it("cold batch 与 strict replay 的 tracker 和最终 snapshot 等价", () => {
    const source = new ProjectionHarness("epoch-source");
    const history = [
      source.event(SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
      source.event(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "run", messageId: "user-cold" },
        "turn-cold",
      ),
      source.event(
        SessionEventType.ToolCallScheduled,
        {
          toolCallId: "tool-cold",
          toolName: "Bash",
          input: { command: "pwd" },
          schedule: { parallelGroups: [["tool-cold"]], executionOrder: ["tool-cold"] },
        },
        "turn-cold",
      ),
      source.event(
        SessionEventType.PermissionRequested,
        {
          requestId: "permission-cold",
          toolCallId: "tool-cold",
          toolName: "Bash",
          riskLevel: "medium",
          reason: "Run command",
          input: { command: "pwd" },
        },
        "turn-cold",
      ),
    ];
    const strict = new ProductProjection(SESSION_ID, "epoch-equivalent");
    const batch = new ProductProjection(SESSION_ID, "epoch-equivalent");
    for (const event of history) strict.applyEvent(event);
    batch.beginHydrationReplay();
    for (const event of history) batch.applyHydrationEvent(event);
    batch.completeHydrationReplay();

    expect(batch.getSnapshot()).toEqual(strict.getSnapshot());
    expect([...projectionInternals(batch).openForegroundToolCallIds]).toEqual(["tool-cold"]);
    expect(projectionInternals(batch).openForegroundToolCallIds).toEqual(
      projectionInternals(strict).openForegroundToolCallIds,
    );

    const terminal = source.event(
      SessionEventType.TurnComplete,
      { response: "", tokenCount: 0, toolCallCount: 1, duration: 1, resultType: "success" },
      "turn-cold",
    );
    strict.applyEvent(terminal);
    batch.applyEvent(terminal);
    expect(batch.getSnapshot()).toEqual(strict.getSnapshot());
    expect(projectionInternals(batch).openForegroundToolCallIds.size).toBe(0);
  });
});
