import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  type EventId,
  type SessionEvent,
  type SessionEventType as SessionEventTypeUnion,
  type SessionId,
  type TraceId,
  type TurnId,
} from "@zcode/contracts";
import { PROTOCOL_V4_LIMITS, utf8JsonByteLength } from "@zcode/shared/zcode-protocol-v4";
import {
  coldHydrationJsonByteLength,
  ConversationTopicPublisher,
  PROJECTION_TERMINAL_RESERVE_BYTES,
} from "../src/zcode-protocol-v4/conversation-topic-publisher.js";

const wireByteProbe = vi.hoisted(() => ({
  snapshotBytesOverride: null as ((value: unknown) => number | null) | null,
  inputs: [] as unknown[],
  snapshotSequences: [] as number[],
}));

vi.mock("@zcode/shared/zcode-protocol-v4", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zcode/shared/zcode-protocol-v4")>();
  return {
    ...actual,
    utf8JsonByteLength(value: unknown): number {
      wireByteProbe.inputs.push(value);
      if (
        typeof value === "object" &&
        value !== null &&
        "payload" in value &&
        typeof value.payload === "object" &&
        value.payload !== null &&
        "kind" in value.payload &&
        value.payload.kind === "snapshot" &&
        "snapshot" in value.payload &&
        typeof value.payload.snapshot === "object" &&
        value.payload.snapshot !== null &&
        "seq" in value.payload.snapshot &&
        typeof value.payload.snapshot.seq === "number"
      ) {
        wireByteProbe.snapshotSequences.push(value.payload.snapshot.seq);
      }
      const snapshotBytesOverride = wireByteProbe.snapshotBytesOverride?.(value);
      if (snapshotBytesOverride !== null && snapshotBytesOverride !== undefined) {
        return snapshotBytesOverride;
      }
      return actual.utf8JsonByteLength(value);
    },
  };
});

function sessionEvent(
  sequenceNumber: number,
  type: SessionEventTypeUnion,
  payload: unknown,
  turnId?: string,
): SessionEvent {
  return {
    id: `event-${sequenceNumber}` as EventId,
    sessionId: "session-1" as SessionId,
    ...(turnId ? { turnId: turnId as TurnId } : {}),
    type,
    timestamp: new Date(1_700_000_000_000 + sequenceNumber),
    traceId: "trace-1" as TraceId,
    sequenceNumber,
    payload,
  };
}

function checkpoint(sequenceNumber: number): SessionEvent {
  return sessionEvent(sequenceNumber, SessionEventType.CheckpointCreated, {
    checkpointId: `checkpoint-${sequenceNumber}`,
    messageId: `message-${sequenceNumber}`,
    targetMessageId: `message-${sequenceNumber}`,
    scope: "workspace",
    snapshotRef: `zcode-artifact://session-1/checkpoint-${sequenceNumber}`,
    fileCount: 1,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshotMeasurementCount(): number {
  return wireByteProbe.inputs.filter((value) => {
    if (!isRecord(value) || !isRecord(value.payload)) return false;
    return value.payload.kind === "snapshot";
  }).length;
}

function snapshotSequence(value: unknown): number | null {
  if (!isRecord(value) || !isRecord(value.payload) || value.payload.kind !== "snapshot") {
    return null;
  }
  if (!isRecord(value.payload.snapshot) || typeof value.payload.snapshot.seq !== "number") {
    return null;
  }
  return value.payload.snapshot.seq;
}

describe("cold hydration wire payload upper bound", () => {
  it.each([
    ["顶层 undefined", undefined],
    ["ASCII", { kind: "deltas", deltas: [{ text: "plain text" }] }],
    ["中文", { text: "冷启动恢复" }],
    ["emoji", { text: "ready 🚀" }],
    ["JSON 转义", { text: "quote: \\\" slash: \\\\ newline:\n tab:\t" }],
    ["未配对 surrogate", { text: "\ud800" }],
  ])("cold-only byte length 对 %s 保持 shared 精确结果", (_name, value) => {
    expect(coldHydrationJsonByteLength(value)).toBe(utf8JsonByteLength(value));
  });

  it("no-delta checkpoint 只在 candidate 初始化和最终事件精确测量", () => {
    const events = [
      sessionEvent(1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
      ...Array.from({ length: 100 }, (_, index) => checkpoint(index + 2)),
    ];
    const strict = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    for (const event of events) strict.ingest(event);
    const cold = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    const byteLengthSpy = vi.spyOn(Buffer, "byteLength");
    const emptyDeltaJson = JSON.stringify({ kind: "deltas", deltas: [] });

    try {
      wireByteProbe.inputs.length = 0;
      cold.rehydrate(events);

      expect(cold.getSnapshot()).toEqual(strict.getSnapshot());
      expect(byteLengthSpy.mock.calls.some(([value]) => value === emptyDeltaJson)).toBe(false);
      expect(snapshotMeasurementCount()).toBe(2);
    } finally {
      byteLengthSpy.mockRestore();
    }
  });

  it("保守增长触及限额时先按当前 snapshot 精确重测，不误回退 strict replay", () => {
    const titleBody = "x".repeat(4 * 1024 * 1024);
    const events = [
      sessionEvent(1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
      ...Array.from({ length: 5 }, (_, index) =>
        sessionEvent(index + 2, SessionEventType.SessionTitleUpdated, {
          previousTitle: index === 0 ? "" : `${index - 1}${titleBody}`,
          title: `${index}${titleBody}`,
          source: "custom",
        }),
      ),
    ];
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });

    wireByteProbe.inputs.length = 0;
    publisher.rehydrate(events);
    expect(snapshotMeasurementCount()).toBeGreaterThan(2);

    const resumed = publisher.subscribe({
      connectionId: "mobile",
      deliveryProfile: "replayable",
      base: { logEpoch: "epoch-1", seq: 1 },
    });
    expect(resumed.ack.mode).toBe("snapshot");
    expect(resumed.frame?.payload.kind).toBe("snapshot");
    expect(utf8JsonByteLength(resumed.frame)).toBeLessThan(
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes,
    );
  });

  it.each([
    { from: 9, to: 10, headroomBytes: 1 },
    { from: 99, to: 100, headroomBytes: 3 },
  ])("sequence $from→$to 位数增长计入上界，并在越界前精确重测", ({ from, to, headroomBytes }) => {
    const events = [checkpoint(from), checkpoint(to), checkpoint(to + 1)];
    const strict = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    for (const event of events) strict.ingest(event);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    const runtimeLimit =
      PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes - PROJECTION_TERMINAL_RESERVE_BYTES;

    wireByteProbe.inputs.length = 0;
    wireByteProbe.snapshotSequences.length = 0;
    wireByteProbe.snapshotBytesOverride = () => runtimeLimit - headroomBytes;
    try {
      publisher.rehydrate(events);
    } finally {
      wireByteProbe.snapshotBytesOverride = null;
    }

    expect(wireByteProbe.snapshotSequences).toEqual([0, to, to + 1]);
    expect(publisher.getSnapshot()).toEqual(strict.getSnapshot());
    expect(
      publisher.subscribe({
        connectionId: "mobile",
        deliveryProfile: "replayable",
        base: { logEpoch: "epoch-1", seq: from },
      }).ack.mode,
    ).toBe("snapshot");
  });

  it.each([
    {
      name: "TurnComplete",
      type: SessionEventType.TurnComplete,
      payload: {
        response: "",
        tokenCount: 0,
        toolCallCount: 0,
        duration: 1,
        resultType: "success",
      },
    },
    {
      name: "TurnError",
      type: SessionEventType.TurnError,
      payload: {
        error: { type: "test.error", message: "failed" },
        turnPhase: "model",
      },
    },
  ])("普通事件后紧接 $name 时可使用 terminal reserve", ({ type, payload }) => {
    const events = [
      sessionEvent(1, SessionEventType.SessionCreated, {
        mode: "default",
        contextWindow: 200_000,
      }),
      sessionEvent(
        2,
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "第一问", messageId: "user-1" },
        "turn-1",
      ),
      sessionEvent(
        3,
        SessionEventType.ModelStreaming,
        {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: "assistant-1",
        },
        "turn-1",
      ),
      sessionEvent(
        4,
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: "第一答", done: false },
        "turn-1",
      ),
      checkpoint(5),
      sessionEvent(6, type, payload, "turn-1"),
    ];
    const strict = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    for (const event of events) strict.ingest(event);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    const fullLimit = PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes;
    const runtimeLimit = fullLimit - PROJECTION_TERMINAL_RESERVE_BYTES;

    wireByteProbe.snapshotSequences.length = 0;
    wireByteProbe.snapshotBytesOverride = (value) => {
      const sequenceNumber = snapshotSequence(value);
      if (sequenceNumber === null) return null;
      return sequenceNumber === 6 ? fullLimit : runtimeLimit - 1024 * 1024;
    };
    try {
      publisher.rehydrate(events);
    } finally {
      wireByteProbe.snapshotBytesOverride = null;
    }

    expect(wireByteProbe.snapshotSequences).toEqual([0, 6]);
    expect(publisher.getSnapshot()).toEqual(strict.getSnapshot());
    expect(
      publisher.subscribe({
        connectionId: "mobile",
        deliveryProfile: "replayable",
        base: { logEpoch: "epoch-1", seq: 1 },
      }).ack.mode,
    ).toBe("snapshot");
  });

  it("row.removed 立即重测，最终事件在 actions 收敛后再次重测", () => {
    const events = [
      sessionEvent(1, SessionEventType.SessionCreated, { mode: "default" }),
      sessionEvent(
        2,
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "第一问", messageId: "user-1" },
        "turn-1",
      ),
      sessionEvent(
        3,
        SessionEventType.ModelStreaming,
        {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: "assistant-1",
        },
        "turn-1",
      ),
      sessionEvent(
        4,
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: "第一答", done: false },
        "turn-1",
      ),
      sessionEvent(
        5,
        SessionEventType.TurnComplete,
        { response: "", tokenCount: 0, toolCallCount: 0, duration: 1, resultType: "success" },
        "turn-1",
      ),
      sessionEvent(
        6,
        SessionEventType.TurnStarted,
        { turnNumber: 2, input: "第二问", messageId: "user-2" },
        "turn-2",
      ),
      sessionEvent(
        7,
        SessionEventType.ModelStreaming,
        {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: "assistant-2",
        },
        "turn-2",
      ),
      sessionEvent(
        8,
        SessionEventType.ModelStreaming,
        { kind: "text_delta", delta: "第二答", done: false },
        "turn-2",
      ),
      sessionEvent(
        9,
        SessionEventType.TurnComplete,
        { response: "", tokenCount: 0, toolCallCount: 0, duration: 1, resultType: "success" },
        "turn-2",
      ),
      sessionEvent(10, SessionEventType.RewindTriggered, {
        targetMessageId: "assistant-2",
        scope: "conversation",
        createdMessageId: "rewind-notice",
      }),
      checkpoint(11),
    ];
    const strict = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });
    for (const event of events) strict.ingest(event);
    const publisher = new ConversationTopicPublisher("session-1", "epoch-1", { now: () => 0 });

    wireByteProbe.inputs.length = 0;
    wireByteProbe.snapshotSequences.length = 0;
    publisher.rehydrate(events);

    expect(snapshotMeasurementCount()).toBe(3);
    expect(wireByteProbe.snapshotSequences).toEqual([0, 10, 11]);
    expect(publisher.getSnapshot()).toEqual(strict.getSnapshot());
    expect(
      publisher
        .getSnapshot()
        .rows.window.filter((row) => row.kind === "userInput")
        .map((row) => row.text),
    ).toEqual(["第一问"]);
  });
});
