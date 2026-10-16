import { describe, expect, it, vi } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { sessionDebugSnapshotSchema } from "@zcode/shared";
import {
  observeSessionDebug,
  readSessionDebug,
  querySessionDebug,
} from "../src/zcode-protocol/session-debug.js";
import { onSessionEvent } from "../src/zcode-protocol/server-operations.js";

const record = () => ({ app: { sessionId: "session-1" } });
function event(id: number, overrides: Record<string, unknown> = {}): SessionEvent {
  return {
    id: `event-${id}`,
    sessionId: "session-1",
    traceId: "trace-1",
    turnId: "turn-1",
    sequenceNumber: id,
    timestamp: new Date(10_000),
    type: SessionEventType.ModelNetworkStatus,
    payload: {
      type: "model_request_completed",
      requestId: `request-${id}`,
      querySource: "main_turn",
      providerId: "provider",
      modelId: "model",
      transport: "sse",
      attempt: 1,
      maxAttempts: 3,
      timestamp: new Date(10_000).toISOString(),
      durationMs: 5000,
      timeToFirstContentMs: 2000,
      usage: { inputTokens: 1000, outputTokens: 120, cacheReadTokens: 800, reasoningTokens: 20 },
      requestHeaders: { authorization: "[redacted]" },
      responseHeaders: { "x-request-id": "upstream" },
      ...overrides,
    },
  } as SessionEvent;
}

describe("session debug observation", () => {
  it("collects without a legacy chat subscription and reads provider request TPS", () => {
    const target = record();
    onSessionEvent(
      { v4Gateway: { ingest: vi.fn() } } as never,
      target as never,
      event(1, { responseBody: "debug-body-must-not-be-forwarded" }),
    );
    const snapshot = sessionDebugSnapshotSchema.parse(readSessionDebug(target));
    expect(snapshot.rounds[0]).toMatchObject({
      tokensPerSecond: 40,
      generationDurationMs: 3000,
      usage: { outputTokens: 120, reasoningTokens: 20 },
    });
    expect(snapshot.cache).toMatchObject({
      hitRateRequestCount: 1,
      totalInputTokens: 1000,
      totalCacheReadTokens: 800,
      hitRate: 0.8,
    });
    expect(snapshot.networkEntries[0]?.requestHeaders.authorization).toBe("[redacted]");
    expect(JSON.stringify(snapshot)).not.toContain("responseBody");
    expect(JSON.stringify(snapshot)).not.toContain("debug-body-must-not-be-forwarded");
  });

  it("deduplicates physical completions, excludes sidecars/failed attempts and isolates sessions", () => {
    const target = record();
    observeSessionDebug(target, event(1));
    observeSessionDebug(target, event(1));
    observeSessionDebug(target, event(2, { requestId: "request-1" }));
    observeSessionDebug(target, event(3, { querySource: "session_title" }));
    observeSessionDebug(
      target,
      event(4, { type: "model_request_failed", reason: "timeout", retryable: true }),
    );
    expect(readSessionDebug(target).rounds).toHaveLength(1);
    expect(readSessionDebug(target).cache?.hitRateRequestCount).toBe(1);
    expect(readSessionDebug(record()).rounds).toHaveLength(0);
    const child = { ...event(5), sessionId: "child" } as SessionEvent;
    observeSessionDebug(target, child);
    expect(readSessionDebug(target).rounds).toHaveLength(1);
  });

  it.each([undefined, 5000, 6000, Number.NaN])(
    "does not invent TPS for invalid first content time %s",
    (first) => {
      const target = record();
      observeSessionDebug(target, event(1, { timeToFirstContentMs: first }));
      expect(readSessionDebug(target).rounds[0]?.tokensPerSecond).toBeNull();
    },
  );

  it("querying cannot resume a cold session or alter activity", () => {
    const target = { ...record(), updatedAt: 123 };
    const context = { sessions: new Map([["session-1", target]]), deps: {} };
    expect(querySessionDebug(context as never, { sessionId: "session-1" }).rounds).toEqual([]);
    expect(target.updatedAt).toBe(123);
    expect(() => querySessionDebug(context as never, { sessionId: "cold" })).toThrow(
      "Session is not active",
    );
    expect(context.sessions.size).toBe(1);
  });

  it("keeps zero output but never adds reasoning to the TPS numerator", () => {
    const target = record();
    observeSessionDebug(target, event(1, { usage: { outputTokens: 0, reasoningTokens: 100 } }));
    expect(readSessionDebug(target).rounds[0]?.tokensPerSecond).toBe(0);
    observeSessionDebug(target, event(2, { usage: {} }));
    expect(readSessionDebug(target).rounds[1]?.tokensPerSecond).toBeNull();
  });

  it("keeps bounded rows while preserving the observation aggregate", () => {
    const target = record();
    for (let i = 1; i <= 250; i++) observeSessionDebug(target, event(i));
    expect(readSessionDebug(target).rounds).toHaveLength(200);
    expect(readSessionDebug(target).networkEntries).toHaveLength(100);
    expect(readSessionDebug(target).cache?.hitRateRequestCount).toBe(250);
    expect(readSessionDebug(target).rounds[0]?.requestIndex).toBe(51);
  });
});
