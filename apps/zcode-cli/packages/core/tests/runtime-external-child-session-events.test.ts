import { describe, expect, it } from "vitest";
import {
  createSessionEvent,
  createSessionId,
  createTurnId,
  SessionEventType,
  type SessionEvent,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";

/**
 * 外部子 runtime 的两个窄接缝（dwf actor / legacy script workflow 用它们做 transcript 直播）。
 * 子 runtime 在 class 外构造，所以既拿不到 private eventStore 也调不到 private notifyEventSinks。
 */
describe("agent runtime external child session seams", () => {
  const parentSessionId = createSessionId("parent-session");
  const childSessionId = createSessionId("child-session");

  function childEvent(): SessionEvent {
    return createSessionEvent(
      SessionEventType.SessionTitleUpdated,
      childSessionId,
      { previousTitle: "", source: "first_input", title: "workflow actor a#1@1" },
      { sequenceNumber: 1, traceId: "trace-child", turnId: createTurnId("turn-child") },
    );
  }

  it("交出的是本 runtime 自己的 event store（供子 runtime 共享）", () => {
    const eventStore = createTestSessionEventStore();
    const runtime = new AgentRuntime(parentSessionId, {}, { eventStore });

    expect(runtime.getSessionEventStore()).toBe(eventStore);
  });

  it("外部子会话事件扇出到外部 sinks，保留子 sessionId", async () => {
    const eventStore = createTestSessionEventStore();
    const constructorSinkEvents: SessionEvent[] = [];
    const subscribedSinkEvents: SessionEvent[] = [];
    const runtime = new AgentRuntime(
      parentSessionId,
      {},
      {
        eventStore,
        eventSink: {
          onSessionEvent: (event) => {
            constructorSinkEvents.push(event);
          },
        },
      },
    );
    runtime.subscribeEvents({
      onSessionEvent: (event) => {
        subscribedSinkEvents.push(event);
      },
    });

    const event = childEvent();
    await runtime.notifyExternalChildSessionEvent({ childSessionId, event });

    // raw child event，一字不改：协议层按 event.sessionId 路由到 detached live session。
    expect(constructorSinkEvents).toEqual([event]);
    expect(subscribedSinkEvents).toEqual([event]);
    expect(constructorSinkEvents[0]!.sessionId).toBe(childSessionId);
    expect(constructorSinkEvents[0]!.sequenceNumber).toBe(1);
  });

  it("只通知不 append：父会话与子会话在 store 里都没有多出事件", async () => {
    const eventStore = createTestSessionEventStore();
    const runtime = new AgentRuntime(parentSessionId, {}, { eventStore });

    await runtime.notifyExternalChildSessionEvent({ childSessionId, event: childEvent() });

    // 子 runtime 已经按自己的 sessionId 落过库；父侧再 append 就是同一事件的第二份。
    expect(await eventStore.getEvents(parentSessionId)).toHaveLength(0);
    expect(await eventStore.getEvents(childSessionId)).toHaveLength(0);
  });

  it("单个 sink 抛错不影响其余 sink（沿用 notifyEventSinks 的隔离）", async () => {
    const eventStore = createTestSessionEventStore();
    const received: SessionEvent[] = [];
    const runtime = new AgentRuntime(
      parentSessionId,
      {},
      {
        eventStore,
        eventSink: {
          onSessionEvent: () => {
            throw new Error("sink boom");
          },
        },
      },
    );
    runtime.subscribeEvents({
      onSessionEvent: (event) => {
        received.push(event);
      },
    });

    await expect(
      runtime.notifyExternalChildSessionEvent({ childSessionId, event: childEvent() }),
    ).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
  });
});
