import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("AgentRuntime reasoning history", () => {
  it("replays streamed reasoning before tool results even without a start event", async () => {
    const sessionId = createSessionId("runtime-orphan-reasoning");
    const eventStore = createTestSessionEventStore();
    const registry = createToolRegistry();
    let modelCallCount = 0;
    let secondRequest: any;

    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "CheckReasoning",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => "tool-ok",
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "yolo", modelStreaming: "on" },
      {
        eventStore,
        toolRegistry: registry,
        modelFactory: createTestModelFactory({
          async generateText() {
            throw new Error("generateText should not be used");
          },
          async *streamText(request: any) {
            modelCallCount++;
            if (modelCallCount === 1) {
              yield {
                type: "reasoning_delta",
                id: "reasoning-1",
                text: "thinking before tool",
              };
              yield {
                type: "tool_call",
                toolCall: {
                  id: "check-reasoning",
                  name: "CheckReasoning",
                  input: {},
                },
              };
              yield {
                type: "finish",
                finishReason: "tool-calls",
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                },
              };
              return;
            }

            secondRequest = request;
            yield { type: "text_delta", text: "done" };
            yield {
              type: "finish",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("run the tool");

    expect(modelCallCount).toBe(2);
    expect(
      secondRequest.messages.find((message: any) => message.role === "assistant"),
    ).toMatchObject({
      content: [{ type: "reasoning", text: "thinking before tool" }],
      toolCalls: [{ id: "check-reasoning", name: "CheckReasoning", input: {} }],
    });
  });
});
