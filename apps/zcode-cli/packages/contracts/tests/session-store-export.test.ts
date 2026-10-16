import { describe, expect, it } from "vitest";
import { createMessageId, createPartId, createSessionId } from "../src/index.js";
import type { ExecutionPort, MessagePart, SessionStorePort } from "../src/index.js";

describe("root contract exports", () => {
  it("exposes session store message part and port types", async () => {
    const part = {
      id: createPartId("root-export"),
      sessionID: createSessionId("root-export"),
      messageID: createMessageId("root-export"),
      type: "text",
      text: "root export contract",
    } satisfies MessagePart;
    const savePart: SessionStorePort["savePart"] = async (input) => {
      expect(input).toBe(part);
    };

    await savePart(part);

    expect(part.type).toBe("text");
  });

  it("exposes ExecutionPort from the root contract entry", async () => {
    const executionPort: ExecutionPort = {
      async run() {
        const now = new Date();
        return {
          status: "completed",
          stdout: { text: "ok", bytes: 2, truncated: false },
          stderr: { text: "", bytes: 0, truncated: false },
          durationMs: 1,
          timedOut: false,
          cancelled: false,
          startedAt: now,
          completedAt: now,
          exitCode: 0,
        };
      },
    };

    const result = await executionPort.run({
      command: {
        mode: "argv",
        file: "node",
        args: ["--version"],
      },
    });

    expect(result.stdout.text).toBe("ok");
  });
});
