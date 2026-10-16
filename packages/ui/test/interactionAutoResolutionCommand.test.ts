import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { sendInteractionAutoResolutionSnooze } from "../src/v4/interactionAutoResolutionCommand.js";

describe("sendInteractionAutoResolutionSnooze", () => {
  it("sends the shared idempotent command and settles the exact command id", async () => {
    let sentEnvelope: CommandEnvelope | null = null;
    const onCommandSettled = vi.fn();

    const accepted = await sendInteractionAutoResolutionSnooze({
      sessionId: "sess-ask",
      interactionId: "interaction-ask",
      source: "taskBadge",
      onCommandSettled,
      sendCommand: async (envelope) => {
        sentEnvelope = envelope;
        return {
          commandId: envelope.commandId,
          status: "accepted",
          revisionAtDecision: 12,
        };
      },
    });

    expect(accepted).toBe(true);
    expect(sentEnvelope).toMatchObject({
      sessionId: "sess-ask",
      type: "snoozeInteractionAutoResolution",
      payload: { interactionId: "interaction-ask" },
    });
    expect(onCommandSettled).toHaveBeenCalledWith(sentEnvelope?.commandId);
  });

  it("reports a rejected command as retryable failure", async () => {
    const accepted = await sendInteractionAutoResolutionSnooze({
      sessionId: "sess-ask",
      interactionId: "interaction-ask",
      source: "taskBadge",
      sendCommand: async (envelope) => ({
        commandId: envelope.commandId,
        status: "rejected",
        reasonCode: "proto.notFound",
        revisionAtDecision: 12,
      }),
    });

    expect(accepted).toBe(false);
  });
});
