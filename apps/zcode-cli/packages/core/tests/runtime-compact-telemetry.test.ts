import { describe, expect, it } from "vitest";
import { createTestModelSelection } from "./test-model-selection.js";
import type { AgentExecutionTelemetryPort } from "@zcode/contracts";
import { CompactTrigger, createRootTraceContext, createSessionId } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory, createTestRuntimeModel } from "./test-runtime-model.js";

describe("AgentRuntime compact telemetry", () => {
  it("Reactive Compact 复用 overflow 路径的当前占用和策略窗口", async () => {
    const { compactionInputTokens, compactionStarts, telemetry } =
      createCompactionTelemetryRecorder();
    const sessionId = createSessionId("runtime-reactive-compact-telemetry");
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        contextWindow: 128_000,
        modelSelection: createTestModelSelection("test/model-a"),
        modelStreaming: "off",
        systemPrompt: "You are a reactive compact telemetry test agent.",
      },
      {
        agentTelemetry: telemetry,
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText() {
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "<summary>Reactive compact telemetry summary.</summary>",
              toolCalls: [],
              usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
            };
          },
        } as never),
      },
    );
    const runtimeInternals = runtime as unknown as {
      messageHistory: {
        addAssistant(content: string, ...args: unknown[]): void;
        addUser(content: string): void;
        borrowReadOnlyRuntimeEntries(): readonly unknown[];
      };
      reactiveCompactAfterContextExceeded(
        error: unknown,
        traceContext: ReturnType<typeof createRootTraceContext>,
        events: unknown[],
        abortSignal: AbortSignal | undefined,
        context: {
          activeEntries: readonly unknown[];
          modelStepIndex: number;
          model: ReturnType<typeof createTestRuntimeModel>;
          rapidRefillCount: number;
        },
      ): Promise<unknown>;
    };
    runtimeInternals.messageHistory.addUser("first reactive telemetry round");
    runtimeInternals.messageHistory.addAssistant("first response");
    runtimeInternals.messageHistory.addUser("second reactive telemetry round");
    runtimeInternals.messageHistory.addAssistant(
      "second response",
      undefined,
      undefined,
      undefined,
      {
        cache: { read: 0, write: 0 },
        input: 10_002,
        output: 10,
        reasoning: 0,
        total: 10_012,
      },
    );
    const activeEntries = runtimeInternals.messageHistory.borrowReadOnlyRuntimeEntries();

    await runtimeInternals.reactiveCompactAfterContextExceeded(
      new Error("provider context overflow"),
      createRootTraceContext({ sessionId }),
      [],
      undefined,
      {
        activeEntries,
        modelStepIndex: 0,
        model: createTestRuntimeModel({
          contextWindow: 128_000,
          generateText: async () => ({ finishReason: "stop", text: "" }),
          modelId: "model-a",
          providerId: "test",
        }),
        rapidRefillCount: 0,
      },
    );

    expect(compactionStarts).toHaveLength(1);
    expect(compactionStarts[0]).toMatchObject({
      phase: "reactive",
      policyContextWindowTokens: 128_000,
      tokenSource: "provider_usage",
      trigger: "reactive",
    });
    expect(compactionStarts[0]?.thresholdTokens).toBeUndefined();
    expect(compactionInputTokens).toHaveLength(1);
    expect(compactionInputTokens[0]).toBeGreaterThanOrEqual(10_002);
  });

  it.each([CompactTrigger.Manual, CompactTrigger.Partial, CompactTrigger.SessionMemory])(
    "%s Compact 不额外构造上下文 telemetry",
    async (trigger) => {
      const { compactionInputTokens, compactionStarts, telemetry } =
        createCompactionTelemetryRecorder();
      const sessionId = createSessionId(`runtime-${trigger}-compact-telemetry`);
      const runtime = createTestAgentRuntime(
        sessionId,
        { contextWindow: 128_000, modelStreaming: "off" },
        {
          agentTelemetry: telemetry,
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            async generateText() {
              throw new Error("Compact model should not run for an empty conversation");
            },
          } as never),
        },
      );
      const runtimeInternals = runtime as unknown as {
        compactActiveConversation(
          customInstructions: string | undefined,
          traceContext: ReturnType<typeof createRootTraceContext>,
          events: unknown[],
          options: { trigger: (typeof CompactTrigger)[keyof typeof CompactTrigger] },
        ): Promise<unknown>;
      };

      await runtimeInternals.compactActiveConversation(
        undefined,
        createRootTraceContext({ sessionId }),
        [],
        { trigger },
      );

      expect(compactionStarts).toHaveLength(1);
      expect(compactionStarts[0]).toMatchObject({ trigger });
      expect(compactionStarts[0]?.policyContextWindowTokens).toBeUndefined();
      expect(compactionStarts[0]?.thresholdTokens).toBeUndefined();
      expect(compactionStarts[0]?.tokenSource).toBeUndefined();
      expect(compactionInputTokens).toEqual([]);
    },
  );
});

function createCompactionTelemetryRecorder() {
  const compactionStarts: Array<Parameters<AgentExecutionTelemetryPort["startCompaction"]>[0]> = [];
  const compactionInputTokens: number[] = [];
  const telemetry = {
    startCompaction(input) {
      compactionStarts.push(input);
      return {
        captureCausation: () => undefined,
        finishCancelled() {},
        finishCompleted() {},
        finishDiscarded() {},
        finishFailed() {},
        markFallbackSelected() {},
        run: (execute) => execute(),
        setInputTokens(tokens) {
          compactionInputTokens.push(tokens);
        },
        setOutputTokens() {},
      };
    },
  } as AgentExecutionTelemetryPort;
  return { compactionInputTokens, compactionStarts, telemetry };
}
