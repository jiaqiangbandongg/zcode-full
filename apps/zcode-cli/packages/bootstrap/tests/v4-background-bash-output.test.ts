import { describe, expect, it, vi } from "vitest";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

describe("background Bash readonly gateway", () => {
  it("queries an existing host without hydrating, subscribing or running commands", async () => {
    const readBackgroundBashOutput = vi
      .fn()
      .mockResolvedValue({ kind: "unavailable", workId: "work" });
    const executeCommand = vi.fn();
    const emitWireFrame = vi.fn();
    const gateway = new ConversationV4Gateway({
      readBackgroundBashOutput,
      executeCommand,
      emitWireFrame,
    } as unknown as V4GatewayHost);
    try {
      expect(await gateway.backgroundBashOutput({ sessionId: "session", workId: "work" })).toEqual({
        kind: "unavailable",
        workId: "work",
      });
      expect(readBackgroundBashOutput).toHaveBeenCalledExactlyOnceWith("session", "work");
      expect(executeCommand).not.toHaveBeenCalled();
      expect(emitWireFrame).not.toHaveBeenCalled();
      await expect(
        gateway.backgroundBashOutput({ sessionId: "session", workId: "work", path: "/secret" }),
      ).rejects.toThrow();
      expect(readBackgroundBashOutput).toHaveBeenCalledTimes(1);
    } finally {
      gateway.dispose();
    }
  });
});
