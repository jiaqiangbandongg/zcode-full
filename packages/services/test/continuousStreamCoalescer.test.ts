import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeStreamEvent } from "@zcode/shared";
import { createContinuousStreamCoalescer } from "../src/session/continuousStreamCoalescer.js";

function messageChunk(content: string, overrides: Partial<Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }>> = {}) {
  return {
    type: "agent_message_chunk",
    taskId: "task-1",
    traceId: "trace-1",
    content,
    ...overrides,
  } satisfies Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }>;
}

function thoughtChunk(content: string) {
  return {
    type: "agent_thought_chunk",
    taskId: "task-1",
    traceId: "trace-1",
    content,
  } satisfies Extract<ZCodeStreamEvent, { type: "agent_thought_chunk" }>;
}

function toolCall() {
  return {
    type: "tool_call",
    taskId: "task-1",
    traceId: "trace-1",
    toolId: "tool-1",
    input: {},
    kind: "execute",
    title: "Bash",
    raw: {},
  } satisfies Extract<ZCodeStreamEvent, { type: "tool_call" }>;
}

function usageUpdate(
  used: number,
): Extract<ZCodeStreamEvent, { type: "usage_update" }> {
  return {
    type: "usage_update",
    taskId: "task-1",
    traceId: "trace-1",
    size: 200000,
    used,
  };
}

function apiRetryUpdate(
  attempt: number,
): Extract<ZCodeStreamEvent, { type: "session_info_update" }> {
  return {
    type: "session_info_update",
    taskId: "task-1",
    traceId: "trace-1",
    apiRetry: {
      kind: "api_retry",
      attempt,
      maxRetries: 5,
      retryDelayMs: 1000,
      errorStatus: 429,
      error: "rate_limit",
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createContinuousStreamCoalescer", () => {
  it("coalesces adjacent message chunks with the same stream key", () => {
    const emitted: ZCodeStreamEvent[] = [];
    const coalescer = createContinuousStreamCoalescer({
      emit: (event) => emitted.push(event),
      flushDelayMs: 100,
    });

    coalescer.accept(messageChunk("a"));
    coalescer.accept(messageChunk("b"));
    coalescer.accept(messageChunk("c"));
    expect(emitted).toHaveLength(0);

    coalescer.flush();

    expect(emitted).toEqual([messageChunk("abc")]);
  });

  it("flushes pending chunks before structural events", () => {
    const emitted: ZCodeStreamEvent[] = [];
    const coalescer = createContinuousStreamCoalescer({
      emit: (event) => emitted.push(event),
      flushDelayMs: 100,
    });
    const call = toolCall();

    coalescer.accept(messageChunk("a"));
    coalescer.accept(call);

    expect(emitted).toEqual([messageChunk("a"), call]);
  });

  it("keeps different chunk keys separated", () => {
    const emitted: ZCodeStreamEvent[] = [];
    const coalescer = createContinuousStreamCoalescer({
      emit: (event) => emitted.push(event),
      flushDelayMs: 100,
    });

    coalescer.accept(messageChunk("a", { parentToolUseId: null }));
    coalescer.accept(messageChunk("b", { parentToolUseId: "tool-1" }));
    coalescer.flush();

    expect(emitted).toEqual([
      messageChunk("a", { parentToolUseId: null }),
      messageChunk("b", { parentToolUseId: "tool-1" }),
    ]);
  });

  it("does not coalesce timeline chunks", () => {
    const emitted: ZCodeStreamEvent[] = [];
    const coalescer = createContinuousStreamCoalescer({
      emit: (event) => emitted.push(event),
      flushDelayMs: 100,
    });
    const timeline = messageChunk("timeline", {
      messageId: "timeline-1",
      zcodeTimeline: {
        version: 1,
        kind: "synthetic",
        type: "context_compaction",
        operationId: "compact-1",
        status: "started",
        trigger: "manual",
        display: "separator",
      },
    });

    coalescer.accept(messageChunk("a"));
    coalescer.accept(timeline);
    coalescer.accept(messageChunk("b"));
    coalescer.flush();

    expect(emitted).toEqual([messageChunk("a"), timeline, messageChunk("b")]);
  });

  it("flushes pending chunks on the configured timer", () => {
    vi.useFakeTimers();
    const emitted: ZCodeStreamEvent[] = [];
    const coalescer = createContinuousStreamCoalescer({
      emit: (event) => emitted.push(event),
      flushDelayMs: 16,
    });

    coalescer.accept(thoughtChunk("thinking"));
    expect(emitted).toHaveLength(0);

    vi.advanceTimersByTime(16);

    expect(emitted).toEqual([thoughtChunk("thinking")]);
  });

  it("keeps only the latest usage update in one continuous frame", () => {
    vi.useFakeTimers();
    const emitted: ZCodeStreamEvent[] = [];
    const coalescer = createContinuousStreamCoalescer({
      emit: (event) => emitted.push(event),
      flushDelayMs: 16,
    });

    coalescer.accept(usageUpdate(10));
    coalescer.accept(usageUpdate(20));
    coalescer.accept(usageUpdate(30));
    expect(emitted).toHaveLength(0);

    vi.advanceTimersByTime(16);

    expect(emitted).toEqual([usageUpdate(30)]);
  });

  it("keeps only the latest api retry session update in one continuous frame", () => {
    vi.useFakeTimers();
    const emitted: ZCodeStreamEvent[] = [];
    const coalescer = createContinuousStreamCoalescer({
      emit: (event) => emitted.push(event),
      flushDelayMs: 16,
    });

    coalescer.accept(apiRetryUpdate(1));
    coalescer.accept(apiRetryUpdate(2));

    vi.advanceTimersByTime(16);

    expect(emitted).toEqual([apiRetryUpdate(2)]);
  });

  it("flushes pending continuous state before structural events", () => {
    const emitted: ZCodeStreamEvent[] = [];
    const coalescer = createContinuousStreamCoalescer({
      emit: (event) => emitted.push(event),
      flushDelayMs: 100,
    });
    const call = toolCall();

    coalescer.accept(messageChunk("a"));
    coalescer.accept(usageUpdate(10));
    coalescer.accept(usageUpdate(20));
    coalescer.accept(call);

    expect(emitted).toEqual([messageChunk("a"), usageUpdate(20), call]);
  });

  it("does not delay session title updates as continuous state", () => {
    const emitted: ZCodeStreamEvent[] = [];
    const coalescer = createContinuousStreamCoalescer({
      emit: (event) => emitted.push(event),
      flushDelayMs: 100,
    });
    const titleUpdate = {
      type: "session_info_update",
      taskId: "task-1",
      traceId: "trace-1",
      title: "新标题",
    } satisfies Extract<ZCodeStreamEvent, { type: "session_info_update" }>;

    coalescer.accept(usageUpdate(10));
    coalescer.accept(titleUpdate);

    expect(emitted).toEqual([usageUpdate(10), titleUpdate]);
  });
});
