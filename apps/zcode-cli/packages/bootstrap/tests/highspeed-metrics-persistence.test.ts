import { describe, expect, it, vi } from "vitest";
import type {
  MessageInfo,
  SessionEvent,
  SessionEventStorePort,
  SessionStorePort,
} from "@zcode/contracts";
import {
  persistHighspeedMetrics,
  persistHighspeedTiming,
} from "../src/zcode-protocol-v4/highspeed-metrics-persistence.js";

function userInfo(): MessageInfo {
  const highspeed = {
    schemaVersion: 1 as const,
    cardId: "hsc-1",
    taskId: "session-1",
    provider: "zai",
    model: "glm-5",
    issuedAt: 1_000,
    expiresAt: 10_000,
    regularTps: 73,
  };
  return {
    id: "user-1" as never,
    sessionID: "session-1" as never,
    role: "user",
    time: { created: 1 },
    agent: "default",
    model: { providerID: "zai", modelID: "glm-5" },
    metadata: {
      retained: "yes",
      highspeed,
      conversationInputIntent: { sourceCommandId: "command-1", highspeed },
    },
  } as MessageInfo;
}

describe("highspeed metrics persistence", () => {
  it("原子更新 message.highspeed 与 intent.highspeed，并发布同一 user entity 事件", async () => {
    let current = userInfo();
    const sessionStore = {
      messages: vi.fn(async () => [{ info: current, parts: [] }]),
      saveMessage: vi.fn(async (info: MessageInfo) => {
        current = info;
      }),
    } as unknown as SessionStorePort;
    const events: SessionEvent[] = [];
    const eventStore = {
      getLatestSequenceNumber: vi.fn(async () => events.length),
      append: vi.fn(async (event: SessionEvent) => {
        events.push(event);
        return event;
      }),
    } as unknown as SessionEventStorePort;

    await persistHighspeedMetrics({
      sessionStore,
      eventStore,
      sessionId: "session-1",
      messageId: "user-1",
      entityId: "user-1",
      traceId: "trace-1",
      metrics: {
        regularTps: 73,
        outputTokens: 120_000,
        durationMs: 881_000,
        highspeedTps: 90,
        savedDurationMs: 762_836,
        modelDurationMs: 600_000,
        toolDurationMs: 200_000,
        otherDurationMs: 81_000,
      },
      onPersistedEvent: () => undefined,
    });

    const metadata = current.metadata as Record<string, unknown>;
    expect(metadata.highspeed).toMatchObject({
      savedDurationMs: 762_836,
      highspeedTps: 90,
      regularTps: 73,
      modelDurationMs: 600_000,
      toolDurationMs: 200_000,
    });
    expect(metadata.conversationInputIntent).toMatchObject({
      highspeed: { savedDurationMs: 762_836, regularTps: 73 },
    });
    expect(events[0]?.payload).toMatchObject({
      entityId: "user-1",
      highspeed: { savedDurationMs: 762_836 },
    });
  });

  it("CLI 终态只凭 highspeed intent 也能持久化真实耗时拆分", async () => {
    let current = userInfo();
    const sessionStore = {
      messages: vi.fn(async () => [{ info: current, parts: [] }]),
      saveMessage: vi.fn(async (info: MessageInfo) => {
        current = info;
      }),
    } as unknown as SessionStorePort;
    const events: SessionEvent[] = [];
    const eventStore = {
      getLatestSequenceNumber: vi.fn(async () => events.length),
      append: vi.fn(async (event: SessionEvent) => {
        events.push(event);
        return event;
      }),
    } as unknown as SessionEventStorePort;

    await persistHighspeedTiming({
      sessionStore,
      eventStore,
      sessionId: "session-1",
      sourceCommandId: "command-1",
      timing: { modelDurationMs: 400, toolDurationMs: 900, otherDurationMs: 1_700 },
      outputTokens: 20,
      durationMs: 3_000,
      traceId: "trace-1",
      onPersistedEvent: () => undefined,
    });

    expect((current.metadata?.highspeed as Record<string, unknown>)?.modelDurationMs).toBe(400);
    expect(events[0]?.type).toBe("highspeed_metrics_updated");
  });

  it("终态耗时持久化把 live 投影的 fallbackAt 写入 metadata 与事件，已持久化的值优先", async () => {
    // CR-02 回归：fallbackAt 只存在于 live 投影；不随终态写入 transcript 时，
    // HighspeedMetricsUpdated 的 payload 与 cold hydration 都拿不到它。
    let current = userInfo();
    const sessionStore = {
      messages: vi.fn(async () => [{ info: current, parts: [] }]),
      saveMessage: vi.fn(async (info: MessageInfo) => {
        current = info;
      }),
    } as unknown as SessionStorePort;
    const events: SessionEvent[] = [];
    const eventStore = {
      getLatestSequenceNumber: vi.fn(async () => events.length),
      append: vi.fn(async (event: SessionEvent) => {
        events.push(event);
        return event;
      }),
    } as unknown as SessionEventStorePort;
    const persist = (
      fallbackAt: number,
      fallbackReason: "highspeed_card_expired" | "highspeed_request_failed",
    ) =>
      persistHighspeedTiming({
        sessionStore,
        eventStore,
        sessionId: "session-1",
        sourceCommandId: "command-1",
        timing: { modelDurationMs: 400, toolDurationMs: 900, otherDurationMs: 1_700 },
        outputTokens: 20,
        durationMs: 3_000,
        fallbackAt,
        fallbackReason,
        traceId: "trace-1",
        onPersistedEvent: () => undefined,
      });

    await persist(5_000, "highspeed_request_failed");
    const persisted = current.metadata?.highspeed as Record<string, unknown>;
    expect(persisted?.fallbackAt).toBe(5_000);
    // fallbackReason 与 fallbackAt 同源同规则持久化，冷恢复后 Toast 文案才不会退回“卡已到期”。
    expect(persisted?.fallbackReason).toBe("highspeed_request_failed");
    expect(current.metadata?.conversationInputIntent).toMatchObject({
      highspeed: { fallbackAt: 5_000, fallbackReason: "highspeed_request_failed" },
    });
    expect(events[0]?.payload).toMatchObject({
      highspeed: { fallbackAt: 5_000, fallbackReason: "highspeed_request_failed" },
    });

    // 只增不删：transcript 已有 fallbackAt/fallbackReason 时不被后到的 live 值改写。
    await persist(9_000, "highspeed_card_expired");
    const after = current.metadata?.highspeed as Record<string, unknown>;
    expect(after?.fallbackAt).toBe(5_000);
    expect(after?.fallbackReason).toBe("highspeed_request_failed");
  });
});
