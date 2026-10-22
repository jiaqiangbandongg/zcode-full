import { expect, it } from "vitest";
import { DEFERRED_TOOL_CALL_NAME, SessionEventType, type SessionEvent } from "@zcode/contracts";
import { ConversationTopicPublisher, ProductProjection } from "../src/zcode-protocol-v4/index.js";
import {
  applyConversationDeltas,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

it.each([false, true])(
  "scheduled identity owns tool rows and plan/CUA consumers (wrapped=%s)",
  (wrapped) => {
    const projection = new ProductProjection("session", "epoch");
    const publisher = new ConversationTopicPublisher("session", "epoch");
    let sequence = 0;
    const apply = (type: SessionEvent["type"], payload: unknown) => {
      const event = {
        id: `event-${++sequence}`,
        sessionId: "session",
        turnId: "turn",
        traceId: "trace",
        timestamp: new Date(1700000000000 + sequence),
        sequenceNumber: sequence,
        type,
        payload,
      } as SessionEvent;
      projection.applyEvent(event);
      publisher.ingest(event);
    };
    apply(SessionEventType.SessionCreated, { mode: "plan", contextWindow: 200000 });
    apply(SessionEventType.TurnStarted, { turnNumber: 1, input: "plan", messageId: "user" });
    const clients = (["continuous", "replayable"] as const).map((deliveryProfile) => {
      const subscription = publisher.subscribe({ connectionId: deliveryProfile, deliveryProfile });
      if (subscription.frame?.payload.kind !== "snapshot")
        throw new Error("expected initial snapshot");
      return {
        deliveryProfile,
        subscriptionId: subscription.ack.subscriptionId,
        snapshot: subscription.frame.payload.snapshot,
      };
    });
    const run = (name: string, input: Record<string, unknown>, content: string) => {
      const id = `call-${sequence}`;
      const raw = {
        kind: "tool_call",
        toolCallId: id,
        toolName: wrapped ? "DeferredToolCall" : name,
        input: wrapped ? { name, input } : input,
        done: false,
        delta: "",
      };
      apply(SessionEventType.ModelStreaming, { ...raw, kind: "tool_input_start" });
      apply(SessionEventType.ModelStreaming, raw);
      apply(SessionEventType.ToolCallScheduled, {
        toolCallId: id,
        toolName: name,
        input,
        schedule: { parallelGroups: [[id]], executionOrder: [id] },
      });
      // 重放/流式终稿不能把已准入的目标输入重新覆盖成包装参数。
      apply(SessionEventType.ModelStreaming, raw);
      apply(SessionEventType.ToolCallStarted, { toolCallId: id, toolName: name });
      apply(SessionEventType.ToolCallResult, {
        toolCallId: id,
        toolName: name,
        result: { success: true, content },
        duration: 1,
      });
      const row = projection
        .getSnapshot()
        .rows.window.find((row) => row.kind === "toolCall" && row.toolCallId === id);
      expect(row).toMatchObject({ toolName: name, input, status: "success" });
      for (const client of clients) {
        const frame = publisher.flush(client.subscriptionId);
        if (frame?.payload.kind !== "deltas") throw new Error("expected live tool deltas");
        client.snapshot = {
          ...applyConversationDeltas(client.snapshot, frame.payload.deltas),
          seq: frame.toSeq,
        } as ConversationSnapshot;
        expect(
          client.snapshot.rows.window.find(
            (row) => row.kind === "toolCall" && row.toolCallId === id,
          ),
        ).toMatchObject({ toolName: name, input, status: "success" });
      }
      return row;
    };
    run("ExitPlanMode", { plan: "# Plan\nImplement it" }, "Approved");
    expect(publisher.getPlans().plans).toHaveLength(1);
    run(
      "mcp__computer-use__list_apps",
      {},
      JSON.stringify({ apps: [{ pid: 123, name: "Browser", bundle_id: "demo.browser" }] }),
    );
    const click = run("mcp__computer-use__click", { app_ref: { pid: 123 }, x: 1, y: 2 }, "Clicked");
    expect(click).toMatchObject({
      cuaApp: { pid: 123, name: "Browser", bundleId: "demo.browser" },
    });
    for (const client of clients) {
      const frame = publisher.subscribe({
        connectionId: `${client.deliveryProfile}-cold`,
        deliveryProfile: client.deliveryProfile,
      }).frame;
      if (frame?.payload.kind !== "snapshot") throw new Error("expected recovery snapshot");
      expect(frame.payload.snapshot.rows.window).toEqual(client.snapshot.rows.window);
    }
  },
);

function createIdentityFixture(toolName = DEFERRED_TOOL_CALL_NAME) {
  const projection = new ProductProjection("session", "epoch");
  const publisher = new ConversationTopicPublisher("session", "epoch");
  let sequence = 0;
  const emit = (type: SessionEvent["type"], payload: unknown, turnId = "turn") => {
    const event = {
      id: `identity-${++sequence}`,
      sessionId: "session",
      turnId,
      traceId: "trace",
      timestamp: new Date(1700000000000 + sequence),
      sequenceNumber: sequence,
      type,
      payload,
    } as SessionEvent;
    const deltas = projection.applyEvent(event);
    publisher.ingest(event);
    return deltas;
  };
  emit(SessionEventType.SessionCreated, { mode: "plan", contextWindow: 200000 });
  emit(SessionEventType.TurnStarted, { turnNumber: 1, input: "plan", messageId: "user" });
  const raw = {
    assistantMessageId: "assistant",
    kind: "tool_call",
    toolCallId: "wrapped",
    toolName,
    input: { name: "TodoWrite", input: { todos: [] } },
    done: false,
    delta: "",
  };
  emit(SessionEventType.ModelStreaming, { ...raw, input: undefined, kind: "tool_input_start" });
  emit(SessionEventType.ModelStreaming, raw);
  const closed = {
    assistantMessageId: "assistant",
    attemptId: "attempt",
    toolCallId: "wrapped",
    toolName: "TodoWrite",
    input: { todos: [{ content: "next", status: "pending", priority: "medium" }] },
    status: "tool_call_closed",
    executionTiming: "during_stream",
  };
  const row = () => projection.getSnapshot().rows.window.find((item) => item.kind === "toolCall");
  return { projection, publisher, emit, raw, closed, row };
}

it("closed target identity updates only the wrapper row and reaches both delivery profiles", () => {
  const { projection, publisher, emit, raw, closed, row } = createIdentityFixture();
  const clients = (["continuous", "replayable"] as const).map((deliveryProfile) => {
    const subscription = publisher.subscribe({ connectionId: deliveryProfile, deliveryProfile });
    if (subscription.frame?.payload.kind !== "snapshot") throw new Error("expected snapshot");
    return {
      subscriptionId: subscription.ack.subscriptionId,
      snapshot: subscription.frame.payload.snapshot,
    };
  });
  const before = projection.getSnapshot();
  const previousRow = row();
  const expected = {
    ...previousRow,
    toolName: closed.toolName,
    input: closed.input,
    inputText: JSON.stringify(closed.input),
  };
  expect(emit(SessionEventType.StreamingToolLedgerUpdated, closed)).toEqual([
    { op: "row.upserted", row: expected },
    { op: "state.updated", patch: { revision: before.revision + 1 } },
  ]);
  expect(row()).toEqual(expected);
  expect(projection.getSnapshot().plan).toEqual(before.plan);
  expect(projection.getSnapshot().goal).toEqual(before.goal);
  expect(projection.getSnapshot().control).toEqual(before.control);
  expect(emit(SessionEventType.StreamingToolLedgerUpdated, closed)).toEqual([]);
  emit(SessionEventType.ModelStreaming, { ...raw, kind: "tool_input_delta", delta: "late" });
  emit(SessionEventType.ModelStreaming, raw);
  expect(row()).toEqual(expected);
  expect(raw.toolName).toBe(DEFERRED_TOOL_CALL_NAME);
  for (const client of clients) {
    const frame = publisher.flush(client.subscriptionId);
    if (frame?.payload.kind !== "deltas") throw new Error("expected identity deltas");
    const snapshot = applyConversationDeltas(client.snapshot, frame.payload.deltas);
    expect(snapshot.rows.window.find((item) => item.kind === "toolCall")).toEqual(expected);
  }
});

it.each([
  "ordinary",
  "missing-row",
  "rejected",
  "missing-input",
  "wrong-status",
  "old-turn",
  "mirrored",
  "settled-turn",
  "scheduled",
])("closed identity leaves %s events unchanged", (scenario) => {
  const { emit, closed, row } = createIdentityFixture(scenario === "ordinary" ? "Read" : undefined);
  if (scenario === "settled-turn") emit(SessionEventType.TurnComplete, { result: "success" });
  if (scenario === "scheduled") {
    emit(SessionEventType.ToolCallScheduled, {
      ...closed,
      schedule: { parallelGroups: [[closed.toolCallId]], executionOrder: [closed.toolCallId] },
    });
  }
  const before = row();
  expect(
    emit(
      SessionEventType.StreamingToolLedgerUpdated,
      {
        ...closed,
        ...(scenario === "missing-row" ? { toolCallId: "missing" } : {}),
        ...(scenario === "rejected" ? { toolName: DEFERRED_TOOL_CALL_NAME } : {}),
        ...(scenario === "missing-input" ? { input: undefined } : {}),
        ...(scenario === "wrong-status" ? { status: "tool_started" } : {}),
        ...(scenario === "mirrored" ? { source: "subagent" } : {}),
        ...(scenario === "scheduled" ? { toolName: "different" } : {}),
      },
      scenario === "old-turn" ? "previous-turn" : "turn",
    ),
  ).toEqual([]);
  expect(row()).toEqual(before);
});

it("identity completion preserves an existing tool error", () => {
  const { emit, closed, row } = createIdentityFixture();
  emit(SessionEventType.ToolCallError, {
    toolCallId: closed.toolCallId,
    error: { type: "interrupted", message: "interrupted" },
  });
  const before = row();
  emit(SessionEventType.StreamingToolLedgerUpdated, closed);
  expect(row()).toEqual({
    ...before,
    toolName: closed.toolName,
    input: closed.input,
    inputText: JSON.stringify(closed.input),
  });
  expect(row()).toMatchObject({ status: "error", error: { message: "interrupted" } });
});
