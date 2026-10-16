import { describe, expect, it, vi } from "vitest";
import type {
  MessageInfo,
  SessionEvent,
  SessionEventStorePort,
  SessionStorePort,
} from "@zcode/contracts";
import { persistAssistantFeedback } from "../src/zcode-protocol-v4/assistant-feedback-persistence.js";

function assistantInfo(): MessageInfo {
  return {
    id: "assistant-1" as never,
    sessionID: "session-1" as never,
    role: "assistant",
    time: { created: 1 },
    parentID: "user-1" as never,
    modelID: "model-1" as never,
    providerID: "provider-1" as never,
    mode: "default",
    agent: "default",
    path: { cwd: "/repo", root: "/repo" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    metadata: { retained: "yes" },
  };
}

describe("assistant feedback persistence", () => {
  it("like 写 metadata；null 只删除 feedback 并保留其它 metadata，随后发布事件", async () => {
    let current = assistantInfo();
    const saveMessage = vi.fn(async (info: MessageInfo) => {
      current = info;
    });
    const sessionStore = {
      messages: vi.fn(async () => [{ info: current, parts: [] }]),
      saveMessage,
    } as unknown as SessionStorePort;
    const persistedEvents: SessionEvent[] = [];
    const eventStore = {
      getLatestSequenceNumber: vi.fn(async () => persistedEvents.length),
      append: vi.fn(async (event: SessionEvent) => {
        persistedEvents.push(event);
        return event;
      }),
    } as unknown as SessionEventStorePort;
    const projected: SessionEvent[] = [];
    const common = {
      sessionStore,
      eventStore,
      sessionId: "session-1",
      messageId: "assistant-1",
      entityId: "assistant-1",
      traceId: "trace-1",
      now: () => 100,
      onPersistedEvent: (event: SessionEvent) => projected.push(event),
    };

    await persistAssistantFeedback({ ...common, feedback: "like" });
    expect(current.metadata).toEqual({ retained: "yes", assistantFeedback: "like" });
    expect(projected.at(-1)?.payload).toEqual({ entityId: "assistant-1", feedback: "like" });

    await persistAssistantFeedback({ ...common, feedback: null });
    expect(current.metadata).toEqual({ retained: "yes" });
    expect(projected.at(-1)?.payload).toEqual({ entityId: "assistant-1", feedback: null });
    expect(saveMessage).toHaveBeenCalledTimes(2);
    expect(eventStore.append).toHaveBeenCalledTimes(2);
  });

  it("event append 失败时补偿 transcript；durable 后 projection 失败不返回失败 ACK", async () => {
    let current = assistantInfo();
    const saveMessage = vi.fn(async (info: MessageInfo) => {
      current = info;
    });
    const sessionStore = {
      messages: vi.fn(async () => [{ info: current, parts: [] }]),
      saveMessage,
    } as unknown as SessionStorePort;
    const appendError = new Error("append failed");
    const eventStore = {
      getLatestSequenceNumber: vi.fn(async () => 0),
      append: vi.fn(async () => {
        throw appendError;
      }),
    } as unknown as SessionEventStorePort;

    await expect(
      persistAssistantFeedback({
        sessionStore,
        eventStore,
        sessionId: "session-1",
        messageId: "assistant-1",
        entityId: "assistant-1",
        traceId: "trace-1",
        feedback: "like",
        onPersistedEvent: () => undefined,
      }),
    ).rejects.toBe(appendError);
    expect(current).toEqual(assistantInfo());
    expect(saveMessage).toHaveBeenCalledTimes(2);

    const persistedEventStore = {
      getLatestSequenceNumber: vi.fn(async () => 0),
      append: vi.fn(async (event: SessionEvent) => event),
    } as unknown as SessionEventStorePort;
    const onLiveProjectionError = vi.fn();
    await expect(
      persistAssistantFeedback({
        sessionStore,
        eventStore: persistedEventStore,
        sessionId: "session-1",
        messageId: "assistant-1",
        entityId: "assistant-1",
        traceId: "trace-1",
        feedback: "dislike",
        onPersistedEvent: () => {
          throw new Error("live projection failed");
        },
        onLiveProjectionError,
      }),
    ).resolves.toBeUndefined();
    expect(current.metadata).toEqual({
      retained: "yes",
      assistantFeedback: "dislike",
    });
    expect(onLiveProjectionError).toHaveBeenCalledOnce();
  });
});
