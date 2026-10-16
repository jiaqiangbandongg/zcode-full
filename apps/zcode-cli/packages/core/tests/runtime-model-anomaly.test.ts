import { describe, expect, it } from "vitest";
import {
  CoreErrorType,
  SessionEventType,
  createSessionId,
  modelMessageContentToText,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("AgentRuntime model anomaly guards", () => {
  it("passes model capability through on main model requests", async () => {
    const sessionId = createSessionId("runtime-max-output-tokens");
    const eventStore = createTestSessionEventStore();
    let capturedMaxOutputTokens: number | undefined;

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        maxOutputTokens: 131_072,
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            capturedMaxOutputTokens = request.options?.maxOutputTokens;
            return {
              finishReason: "stop",
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("check max output token passthrough");

    expect(capturedMaxOutputTokens).toBe(131_072);
  });

  it("uses the 32k fallback on main requests when the model does not declare a limit", async () => {
    const sessionId = createSessionId("runtime-default-output-tokens");
    let capturedMaxOutputTokens: number | undefined;

    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            capturedMaxOutputTokens = request.options?.maxOutputTokens;
            return {
              finishReason: "stop",
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("check default max output tokens");

    expect(capturedMaxOutputTokens).toBe(32_000);
  });

  it("fails visibly when the provider returns an empty non-stop result", async () => {
    const sessionId = createSessionId("runtime-empty-non-stop-model-result");
    const eventStore = createTestSessionEventStore();

    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            return {
              finishReason: "error",
              providerMetadata: { finishReason: "error" },
              text: "",
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
              },
            };
          },
        } as never),
      },
    );

    await expect(runtime.executeTurn("trigger empty model result")).rejects.toMatchObject({
      message: "Model returned no text, no tool calls, and no usage before completing the turn.",
      type: CoreErrorType.ModelError,
    });

    const events = await eventStore.getEvents(sessionId);
    const turnError = events.find((event) => event.type === SessionEventType.TurnError);
    expect(turnError?.payload).toMatchObject({
      error: {
        attribution: {
          modelId: expect.any(String),
          providerId: expect.any(String),
          reason: "empty_model_response",
          source: "provider",
        },
        message: "Model returned no text, no tool calls, and no usage before completing the turn.",
        type: CoreErrorType.ModelError,
      },
    });
  });

  it("prefers provider business metadata over suspicious empty when security verification fails", async () => {
    const sessionId = createSessionId("runtime-empty-with-provider-business-metadata");
    const eventStore = createTestSessionEventStore();

    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            return {
              finishReason: "error",
              providerMetadata: {
                response: {
                  body: {
                    code: 3007,
                    msg: "安全校验失败",
                    success: false,
                  },
                },
              },
              text: "",
              usage: {
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
              },
            };
          },
        } as never),
      },
    );

    await expect(runtime.executeTurn("trigger provider business error")).rejects.toMatchObject({
      message: "安全校验失败",
      type: CoreErrorType.ModelError,
    });

    const events = await eventStore.getEvents(sessionId);
    const turnError = events.find((event) => event.type === SessionEventType.TurnError);
    expect(turnError?.payload).toMatchObject({
      error: {
        code: "3007",
        message: "安全校验失败",
        type: CoreErrorType.ModelError,
      },
    });
  });

  it("continues a streaming successful raw output-limit before suspicious empty", async () => {
    const sessionId = createSessionId("runtime-stream-empty-context-overflow");
    const eventStore = createTestSessionEventStore();
    const requestTexts: string[] = [];

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        modelStreaming: "on",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText() {
            throw new Error("streaming path expected");
          },
          async *streamText(request: any) {
            requestTexts.push(
              request.messages
                .map((message: any) => modelMessageContentToText(message.content))
                .join("\n"),
            );
            if (requestTexts.length > 1) {
              yield { type: "text_delta", text: "done" };
              yield {
                type: "finish",
                finishReason: "stop",
                model: request.model,
                usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
              };
              return;
            }
            yield {
              type: "finish",
              finishReason: "other",
              providerMetadata: { rawFinishReason: "max_output_tokens" },
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("trigger streaming context overflow");

    const events = await eventStore.getEvents(sessionId);
    expect(result.response).toBe("done");
    expect(requestTexts).toHaveLength(2);
    expect(requestTexts[1]).toContain("Output token limit hit. Resume directly");
    expect(events.some((event) => event.type === SessionEventType.TurnError)).toBe(false);
  });

  it("injects a repeated tool call warning after the third identical call", async () => {
    const sessionId = createSessionId("runtime-repeated-tool-call-warning");
    const eventStore = createTestSessionEventStore();
    const registry = createToolRegistry();
    const requestContexts: string[] = [];
    let executedToolCount = 0;
    let modelCallCount = 0;

    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "Noop",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => {
        executedToolCount += 1;
        return "ok";
      },
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "yolo" },
      {
        eventStore,
        toolRegistry: registry,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            modelCallCount += 1;
            requestContexts.push(
              request.messages
                .map((message: { content: unknown }) => modelMessageContentToText(message.content))
                .join("\n---\n"),
            );

            if (modelCallCount === 1) {
              return toolCallResponse({
                id: "noop-1",
                name: "Noop",
                input: { path: "README.md", limit: 5 },
              });
            }
            if (modelCallCount === 2) {
              return toolCallResponse({
                id: "noop-2",
                name: "Noop",
                input: { limit: 5, path: "README.md" },
              });
            }
            if (modelCallCount === 3) {
              return toolCallResponse({
                id: "noop-3",
                name: "Noop",
                input: { path: "README.md", limit: 5 },
              });
            }

            return stopResponse("done");
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("trigger repeated tool calls");
    const events = await eventStore.getEvents(sessionId);
    const warningEvents = events.filter(
      (event) => event.type === SessionEventType.ModelAnomalyWarning,
    );

    expect(result.response).toBe("done");
    expect(executedToolCount).toBe(3);
    expect(warningEvents).toHaveLength(1);
    expect(warningEvents[0]?.payload).toMatchObject({
      category: "repeated_tool_call",
      observedCount: 3,
      threshold: 3,
      toolCallId: "noop-3",
      toolName: "Noop",
      warningInjected: true,
    });
    expect(requestContexts[3]).toContain(
      "You have called Noop with the same input 3 times in a row.",
    );
  });

  it("resets the repeated-call streak when the tool input changes", async () => {
    const sessionId = createSessionId("runtime-repeated-tool-call-reset");
    const eventStore = createTestSessionEventStore();
    const registry = createToolRegistry();
    let executedToolCount = 0;
    let modelCallCount = 0;

    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "Noop",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => {
        executedToolCount += 1;
        return "ok";
      },
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      { mode: "yolo" },
      {
        eventStore,
        toolRegistry: registry,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            modelCallCount += 1;
            if (modelCallCount === 1) {
              return toolCallResponse({
                id: "noop-a1",
                name: "Noop",
                input: { path: "README.md" },
              });
            }
            if (modelCallCount === 2) {
              return toolCallResponse({
                id: "noop-a2",
                name: "Noop",
                input: { path: "README.md" },
              });
            }
            if (modelCallCount === 3) {
              return toolCallResponse({
                id: "noop-b1",
                name: "Noop",
                input: { path: "package.json" },
              });
            }
            if (modelCallCount === 4) {
              return toolCallResponse({
                id: "noop-b2",
                name: "Noop",
                input: { path: "package.json" },
              });
            }
            if (modelCallCount === 5) {
              return toolCallResponse({
                id: "noop-b3",
                name: "Noop",
                input: { path: "package.json" },
              });
            }

            return stopResponse("done");
          },
        } as never),
      },
    );

    await runtime.executeTurn("reset repeated tool call streak");
    const events = await eventStore.getEvents(sessionId);
    const warningEvents = events.filter(
      (event) => event.type === SessionEventType.ModelAnomalyWarning,
    );

    expect(executedToolCount).toBe(5);
    expect(warningEvents).toHaveLength(1);
    expect(warningEvents[0]?.payload).toMatchObject({
      observedCount: 3,
      toolCallId: "noop-b3",
      toolName: "Noop",
    });
  });

  it("injects a tool call budget warning when the configured threshold is crossed", async () => {
    const sessionId = createSessionId("runtime-tool-call-budget-warning");
    const eventStore = createTestSessionEventStore();
    const registry = createToolRegistry();
    const requestContexts: string[] = [];
    let executedToolCount = 0;
    let modelCallCount = 0;

    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "Noop",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => {
        executedToolCount += 1;
        return "ok";
      },
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "yolo",
        modelAnomalyGuard: {
          toolCallWarningThreshold: 2,
        },
      },
      {
        eventStore,
        toolRegistry: registry,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            modelCallCount += 1;
            requestContexts.push(
              request.messages
                .map((message: { content: unknown }) => modelMessageContentToText(message.content))
                .join("\n---\n"),
            );

            if (modelCallCount <= 2) {
              return toolCallResponse({
                id: `noop-${modelCallCount}`,
                name: "Noop",
                input: { step: modelCallCount },
              });
            }

            return stopResponse("done");
          },
        } as never),
      },
    );

    await runtime.executeTurn("trigger tool call budget warning");
    const events = await eventStore.getEvents(sessionId);
    const warningEvents = events.filter(
      (event) => event.type === SessionEventType.ModelAnomalyWarning,
    );

    expect(executedToolCount).toBe(2);
    expect(warningEvents).toHaveLength(1);
    expect(warningEvents[0]?.payload).toMatchObject({
      category: "tool_call_budget",
      observedCount: 2,
      threshold: 2,
      warningInjected: true,
    });
    expect(requestContexts[2]).toContain("This turn has already made 2 tool calls.");
  });
});

function toolCallResponse(toolCall: { id: string; name: string; input: unknown }) {
  return {
    finishReason: "tool-calls",
    providerMetadata: undefined,
    text: "",
    toolCalls: [toolCall],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
  };
}

function stopResponse(text: string) {
  return {
    finishReason: "stop",
    providerMetadata: undefined,
    text,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    },
  };
}
