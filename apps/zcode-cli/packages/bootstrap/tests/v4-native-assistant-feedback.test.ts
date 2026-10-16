import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import type { V4CommandCoreHost } from "../src/zcode-protocol-v4/commands/types.js";

function envelope(feedback: "like" | "dislike" | null): CommandEnvelope {
  return {
    commandId: "feedback-command",
    clientId: "desktop-client",
    sessionId: "session-1",
    baseRevision: 4,
    baseLogEpoch: "epoch-1",
    type: "setAssistantFeedback",
    payload: {
      target: { rowId: 9, entityId: "assistant-1" },
      feedback,
    },
    issuedAt: 1_700_000_000_000,
  };
}

function host(setAssistantFeedback = vi.fn().mockResolvedValue(undefined)): V4CommandCoreHost {
  return {
    getRecord: () => ({ app: { sessionId: "session-1" } }) as never,
    resolveRowActionTarget: () =>
      ({
        ok: true,
        action: "setAssistantFeedback",
        messageId: "assistant-1",
        row: { kind: "assistantText" },
      }) as never,
    setAssistantFeedback,
  } as V4CommandCoreHost;
}

describe("v4 setAssistantFeedback", () => {
  it("把 row CAS 解析出的 message/entity 与 nullable feedback 交给持久化 host", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const executor = new V4CommandExecutor(host(persist));

    await executor.execute(envelope(null));

    expect(persist).toHaveBeenCalledWith("session-1", {
      entityId: "assistant-1",
      messageId: "assistant-1",
      feedback: null,
    });
  });

  it("stale row target 不写持久化", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const staleHost = host(persist);
    staleHost.resolveRowActionTarget = () =>
      ({ ok: false, status: "stale", reasonCode: "proto.staleTarget" }) as never;

    await expect(new V4CommandExecutor(staleHost).execute(envelope("like"))).rejects.toThrow();
    expect(persist).not.toHaveBeenCalled();
  });
});
