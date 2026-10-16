import { describe, expect, it } from "vitest";
import type { MessageInfo } from "@zcode/contracts";
import { createMessageId } from "@zcode/contracts";
import { persistCompactSummary } from "../src/runtime/methods/compact-persistence.js";

describe("compact persistence model selection", () => {
  it("projects the session selection when no execution model was supplied", async () => {
    const saved: MessageInfo[] = [];
    const runtime = {
      config: { agentName: "test-agent", systemPrompt: "test" },
      getSessionModelSelection: () => {
        throw new Error("compact persistence must read the session selection");
      },
      getSessionModelSelection: () => ({
        providerId: "selection-provider",
        modelId: "selection-model",
        options: { reasoningLevel: "high" },
      }),
      getTools: () => [],
      persistMessage: async (message: MessageInfo) => {
        saved.push(message);
      },
      persistPart: async () => {},
      sessionId: "session-compact-selection",
      sessionStore: {},
    };

    await persistCompactSummary.call(
      runtime as never,
      createMessageId(),
      "compact content",
      "compact summary",
      {
        trigger: "manual",
        phase: "post_response",
        compactReason: "manual",
      } as never,
      { traceId: "trace-compact-selection" } as never,
    );

    expect(saved[0]).toMatchObject({
      modelSelection: {
        providerId: "selection-provider",
        modelId: "selection-model",
      },
    });
  });
});
