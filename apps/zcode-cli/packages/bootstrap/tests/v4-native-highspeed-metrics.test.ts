import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import type { V4CommandCoreHost } from "../src/zcode-protocol-v4/commands/types.js";

function envelope(): CommandEnvelope {
  return {
    commandId: "highspeed-metrics-command",
    clientId: "desktop-client",
    sessionId: "session-1",
    baseRevision: 4,
    baseLogEpoch: "epoch-1",
    type: "setHighspeedMetrics",
    payload: {
      target: { rowId: 8, entityId: "user-1" },
      regularTps: 73,
      outputTokens: 120_000,
      durationMs: 881_000,
      highspeedTps: 90,
      savedDurationMs: 762_836,
    },
    issuedAt: 1_700_000_000_000,
  };
}

describe("v4 setHighspeedMetrics", () => {
  it("把 user row 解析出的消息锚点和完成态统计交给持久化 host", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const host = {
      getRecord: () => ({ app: { sessionId: "session-1" } }) as never,
      resolveRowActionTarget: () => ({
        ok: true,
        action: "setHighspeedMetrics",
        messageId: "user-1",
        row: { kind: "userInput" },
      }),
      setHighspeedMetrics: persist,
    } as V4CommandCoreHost;

    await new V4CommandExecutor(host).execute(envelope());

    expect(persist).toHaveBeenCalledWith("session-1", {
      entityId: "user-1",
      messageId: "user-1",
      metrics: {
        regularTps: 73,
        outputTokens: 120_000,
        durationMs: 881_000,
        highspeedTps: 90,
        savedDurationMs: 762_836,
      },
    });
  });

  it("stale row target 不写持久化", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const host = {
      getRecord: () => ({ app: { sessionId: "session-1" } }) as never,
      resolveRowActionTarget: () => ({
        ok: false,
        status: "stale",
        reasonCode: "proto.staleTarget",
      }),
      setHighspeedMetrics: persist,
    } as V4CommandCoreHost;

    await expect(new V4CommandExecutor(host).execute(envelope())).rejects.toThrow();
    expect(persist).not.toHaveBeenCalled();
  });
});
