import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeSessionEvent } from "@zcode/shared";
import type { ZCodeAgentServiceEvent } from "../src/zcode-agent/zcodeAgent.js";
import { createBackgroundSessionEventCoalescer } from "../src/zcode-agent/zcodeSessionEventCoalescer.js";

function sessionEvent(
  type: ZCodeSessionEvent["type"],
  payload: Record<string, unknown>,
  overrides: Partial<ZCodeSessionEvent> = {},
): ZCodeAgentServiceEvent {
  return {
    type: "session.event",
    event: {
      type,
      eventId: `evt-${Math.random()}`,
      sessionId: "sess-1",
      seq: 1,
      timestamp: 1_700_000_000_000,
      traceId: "trace-1",
      payload,
      ...overrides,
    } as ZCodeSessionEvent,
  };
}

function textDelta(delta: string, overrides: Partial<ZCodeSessionEvent> = {}) {
  return sessionEvent(
    "model.streaming",
    {
      kind: "text_delta",
      delta,
      inputId: "input-1",
      assistantMessageId: "assistant-1",
    },
    overrides,
  );
}

function toolProgress(stdoutBytes: number) {
  return sessionEvent("tool.updated", {
    kind: "progress",
    toolCallId: "tool-1",
    toolName: "Bash",
    inputId: "input-1",
    stdoutBytes,
  });
}

function toolResult() {
  return sessionEvent("tool.updated", {
    kind: "result",
    toolCallId: "tool-1",
    toolName: "Bash",
    result: { success: true, content: "done" },
    duration: 10,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createBackgroundSessionEventCoalescer", () => {
  it("coalesces model streaming deltas for background subscribers", () => {
    const emitted: ZCodeAgentServiceEvent[] = [];
    const coalescer = createBackgroundSessionEventCoalescer({
      emit: (event) => emitted.push(event),
      flushDelayMs: 100,
    });

    coalescer.accept(textDelta("a"));
    coalescer.accept(textDelta("b"));
    coalescer.accept(textDelta("c"));
    coalescer.flush();

    expect(emitted).toHaveLength(1);
    const event = emitted[0];
    expect(event?.type).toBe("session.event");
    expect(
      event?.type === "session.event" ? event.event.payload : null,
    ).toMatchObject({ delta: "abc" });
  });

  it("flushes pending deltas before structural session events", () => {
    const emitted: ZCodeAgentServiceEvent[] = [];
    const coalescer = createBackgroundSessionEventCoalescer({
      emit: (event) => emitted.push(event),
      flushDelayMs: 100,
    });
    const result = toolResult();

    coalescer.accept(textDelta("a"));
    coalescer.accept(result);

    expect(emitted).toHaveLength(2);
    expect(
      emitted[0]?.type === "session.event" ? emitted[0].event.payload : null,
    ).toMatchObject({ delta: "a" });
    expect(emitted[1]).toBe(result);
  });

  it("flushes pending deltas when a background subscriber is disposed", () => {
    const emitted: ZCodeAgentServiceEvent[] = [];
    const coalescer = createBackgroundSessionEventCoalescer({
      emit: (event) => emitted.push(event),
      flushDelayMs: 100,
    });

    coalescer.accept(textDelta("前半段"));
    coalescer.accept(textDelta("继续"));
    coalescer.dispose();

    expect(emitted).toHaveLength(1);
    expect(
      emitted[0]?.type === "session.event" ? emitted[0].event.payload : null,
    ).toMatchObject({ delta: "前半段继续" });
  });

  it("keeps only the latest tool progress event in one background window", () => {
    vi.useFakeTimers();
    const emitted: ZCodeAgentServiceEvent[] = [];
    const coalescer = createBackgroundSessionEventCoalescer({
      emit: (event) => emitted.push(event),
      flushDelayMs: 100,
    });

    coalescer.accept(toolProgress(10));
    coalescer.accept(toolProgress(20));
    coalescer.accept(toolProgress(30));

    expect(emitted).toHaveLength(0);
    vi.advanceTimersByTime(100);

    expect(emitted).toHaveLength(1);
    expect(
      emitted[0]?.type === "session.event" ? emitted[0].event.payload : null,
    ).toMatchObject({ stdoutBytes: 30 });
  });

  it("flushes pending events before snapshots", () => {
    const emitted: ZCodeAgentServiceEvent[] = [];
    const coalescer = createBackgroundSessionEventCoalescer({
      emit: (event) => emitted.push(event),
      flushDelayMs: 100,
    });
    const snapshot = {
      type: "snapshot",
      snapshot: {
        session: { sessionId: "sess-1", title: "t", status: "running" },
        workspace: { rootPath: "/repo" },
        settings: {
          model: { current: { providerId: "glm", modelId: "m" }, available: [] },
          mode: { current: "build", available: [] },
          thoughtLevel: { enabled: false, available: [] },
        },
        runtime: { eventSeq: 1, stateRevision: 1, pendingRequestIds: [] },
        projection: {},
        messages: [],
      },
    } as ZCodeAgentServiceEvent;

    coalescer.accept(textDelta("a"));
    coalescer.accept(snapshot);

    expect(emitted[0]?.type).toBe("session.event");
    expect(emitted[1]).toBe(snapshot);
  });
});
