import { describe, expect, it } from "vitest";
import { v4ConversationSubscribeResultSchema } from "../src/zcode-protocol-v4/transport.js";

describe("v4 conversation subscribe open timing", () => {
  it("accepts additive timing metadata only on the conversation subscribe ACK", () => {
    const result = v4ConversationSubscribeResultSchema.parse({
      ack: {
        subscriptionId: "sub-1",
        mode: "snapshot",
        logEpoch: "epoch-1",
        openTiming: {
          version: 1,
          hostPrepareMs: 12,
          cliBootstrapMs: 34,
          cliSessionRestoreMs: 56,
          initialFrameEncodeMs: 13,
          cliProcessState: "spawned",
          sessionRuntimeState: "cold",
          snapshotRowCount: 30,
        },
      },
    });

    expect(result.ack.openTiming).toMatchObject({
      version: 1,
      cliSessionRestoreMs: 56,
      cliProcessState: "spawned",
      sessionRuntimeState: "cold",
    });
  });

  it("keeps legacy ACK-only subscribe responses valid", () => {
    expect(
      v4ConversationSubscribeResultSchema.parse({
        ack: {
          subscriptionId: "sub-1",
          mode: "resume",
          logEpoch: "epoch-1",
        },
      }),
    ).toEqual({
      ack: {
        subscriptionId: "sub-1",
        mode: "resume",
        logEpoch: "epoch-1",
      },
    });
  });
});
