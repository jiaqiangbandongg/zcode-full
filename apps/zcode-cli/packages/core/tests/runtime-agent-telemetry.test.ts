import { describe, expect, it, vi } from "vitest";
import type { AgentExecutionTelemetryPort } from "@zcode/contracts";
import { createSessionId } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("AgentRuntime telemetry integration", () => {
  it("Auto Compact 复用策略决策值上报当前占用、窗口和阈值", async () => {
    const lifecycle: string[] = [];
    const compactionStarts: Array<Parameters<AgentExecutionTelemetryPort["startCompaction"]>[0]> =
      [];
    const compactionInputTokens: number[] = [];
    const telemetry = createRecordingTelemetry(lifecycle);
    const startCompaction = telemetry.startCompaction.bind(telemetry);
    telemetry.startCompaction = (input) => {
      compactionStarts.push(input);
      const writer = startCompaction(input);
      return {
        ...writer,
        setInputTokens(tokens) {
          compactionInputTokens.push(tokens);
          writer.setInputTokens(tokens);
        },
      };
    };
    const info = vi.fn();
    const logger = {
      child: () => logger,
      debug: vi.fn(),
      error: vi.fn(),
      info,
      warn: vi.fn(),
    };
    let mainRequestCount = 0;
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-auto-compact-telemetry"),
      {
        maxOutputTokens: 64_000,
        modelContextBudgetStrategy: "preflight-v1",
        modelStreaming: "off",
      },
      {
        agentTelemetry: telemetry,
        eventStore: createTestSessionEventStore(),
        logger,
        modelFactory: createTestModelFactory({
          properties: { contextWindow: 128_000 },
          async generateText(_request, observation) {
            if (observation.invocationContext?.modelCall?.operation === "context_compaction") {
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "<summary>Telemetry compact summary.</summary>",
                toolCalls: [],
                usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
              };
            }
            mainRequestCount += 1;
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: `response-${mainRequestCount}`,
              toolCalls: [],
              usage:
                mainRequestCount === 1
                  ? { inputTokens: 94_001, outputTokens: 1, totalTokens: 94_002 }
                  : { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("seed provider usage");
    await runtime.executeTurn("trigger auto compact");

    const decisionLog = info.mock.calls
      .map((call) => call[1])
      .find((context) => context?.event === "compact.auto.started");
    expect(decisionLog).toMatchObject({
      contextWindow: 128_000,
      threshold: 94_000,
      tokenSource: "provider_usage",
    });
    expect(compactionStarts).toHaveLength(1);
    expect(compactionStarts[0]).toMatchObject({
      phase: "pre_request",
      policyContextWindowTokens: 128_000,
      thresholdTokens: 94_000,
      tokenSource: "provider_usage",
      trigger: "auto",
    });
    expect(compactionInputTokens).toEqual([decisionLog.tokenCount]);
  });

  it("只在 Turn/Step 权威边界调用端口，并由 Scope 包裹真实模型执行", async () => {
    const lifecycle: string[] = [];
    const telemetry = createRecordingTelemetry(lifecycle);
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-agent-telemetry"),
      {
        modelStreaming: "off",
        workingDirectory: "/tmp/runtime-agent-telemetry",
      },
      {
        agentTelemetry: telemetry,
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText() {
            lifecycle.push("model.execute");
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              toolCalls: [],
              usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("hello");

    expect(result.response).toBe("done");
    expect(lifecycle).toEqual([
      "turn.start",
      "turn.run",
      "step.start",
      "step.run",
      "model.execute",
      "step.end:completed",
      "turn.end:completed",
    ]);
  });

  it.each([
    ["child", "child"],
    ["linked_root", "linked_root"],
  ] as const)(
    "Subagent Runtime 继续产生完整 Turn/Step，并保留 %s 因果模式",
    async (_label, causationMode) => {
      const lifecycle: string[] = [];
      const parentSessionId = createSessionId("runtime-subagent-parent");
      const turnStarts: Parameters<AgentExecutionTelemetryPort["startTurn"]>[0][] = [];
      const stepStarts: Parameters<AgentExecutionTelemetryPort["startStep"]>[0][] = [];
      const modelCalls: unknown[] = [];
      const telemetry = createRecordingTelemetry(lifecycle);
      const startTurn = telemetry.startTurn.bind(telemetry);
      const startStep = telemetry.startStep.bind(telemetry);
      telemetry.startTurn = (input) => {
        turnStarts.push(input);
        return startTurn(input);
      };
      telemetry.startStep = (input) => {
        stepStarts.push(input);
        return startStep(input);
      };
      const runtime = createTestAgentRuntime(
        createSessionId(`runtime-subagent-telemetry-${causationMode}`),
        {
          agentName: "zcode-general-purpose",
          modelStreaming: "off",
          parentSessionId,
          taskType: "subagent_child",
          workingDirectory: "/tmp/runtime-subagent-telemetry",
        },
        {
          agentTelemetry: telemetry,
          agentTelemetryCausation: {
            isRemote: false,
            sessionId: String(parentSessionId),
            spanId: "1234567890abcdef",
            traceFlags: 1,
            traceId: "1234567890abcdef1234567890abcdef",
            turnId: "turn-parent",
          },
          agentTelemetryCausationMode: causationMode,
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            async generateText(_request, observation) {
              modelCalls.push(observation.invocationContext?.modelCall);
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "child done",
                toolCalls: [],
                usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
              };
            },
          } as never),
        },
      );

      await runtime.executeTurn("child prompt", undefined, {
        inputSource: "subagent",
      });

      expect(turnStarts).toHaveLength(1);
      expect(turnStarts[0]).toMatchObject({
        causationMode,
        context: {
          actorKind: "subagent",
          agentName: "zcode-general-purpose",
          parentSessionId,
          parentTurnId: "turn-parent",
        },
        inputSource: "subagent",
      });
      expect(stepStarts).toHaveLength(1);
      expect(stepStarts[0]).toMatchObject({ stepIndex: 0 });
      expect(modelCalls).toEqual([
        expect.objectContaining({
          actorKind: "subagent",
          operation: "agent_step",
        }),
      ]);
    },
  );
});

function createRecordingTelemetry(lifecycle: string[]): AgentExecutionTelemetryPort {
  return {
    abandonSession() {},
    captureCausation() {
      return undefined;
    },
    startCompaction() {
      lifecycle.push("compaction.start");
      return {
        ...recordingBase("compaction", lifecycle),
        finishCancelled: (reason: string) => lifecycle.push(`compaction.cancel:${reason}`),
        finishCompleted: () => lifecycle.push("compaction.end:completed"),
        finishDiscarded: () => lifecycle.push("compaction.end:discarded"),
        finishFailed: (stage: string) => lifecycle.push(`compaction.fail:${stage}`),
        markFallbackSelected() {},
        setInputTokens() {},
        setOutputTokens() {},
      };
    },
    startDetachedOperation(input) {
      lifecycle.push(`detached.start:${input.operation}`);
      return {
        ...recordingBase("detached", lifecycle),
        finishCancelled: (reason: string) => lifecycle.push(`detached.cancel:${reason}`),
        finishCompleted: () => lifecycle.push("detached.end:completed"),
        finishFailed: (stage: string) => lifecycle.push(`detached.fail:${stage}`),
        setResultType() {},
      };
    },
    startStep() {
      lifecycle.push("step.start");
      return {
        ...recordingBase("step", lifecycle),
        finishCancelled: (reason: string) => lifecycle.push(`step.cancel:${reason}`),
        finishCompleted: () => lifecycle.push("step.end:completed"),
        finishDiscarded: () => lifecycle.push("step.end:discarded"),
        finishFailed: (stage: string) => lifecycle.push(`step.fail:${stage}`),
      };
    },
    startTool() {
      lifecycle.push("tool.start");
      return {
        ...recordingBase("tool", lifecycle),
        finishCancelled: (reason: string) => lifecycle.push(`tool.cancel:${reason}`),
        finishCompleted: () => lifecycle.push("tool.end:completed"),
        finishDenied: (reason: string) => lifecycle.push(`tool.denied:${reason}`),
        finishFailed: (stage: string) => lifecycle.push(`tool.fail:${stage}`),
        markPermissionRequested() {},
        setOutputBytes() {},
        setOutputTruncated() {},
        setPermissionDecision() {},
        startCommand() {
          throw new Error("command writer is not used by this test");
        },
      };
    },
    startTurn() {
      lifecycle.push("turn.start");
      return {
        ...recordingBase("turn", lifecycle),
        finishCancelled: (reason: string) => lifecycle.push(`turn.cancel:${reason}`),
        finishCompleted: () => lifecycle.push("turn.end:completed"),
        finishFailed: (stage: string) => lifecycle.push(`turn.fail:${stage}`),
      };
    },
  };
}

function recordingBase(name: string, lifecycle: string[]) {
  return {
    captureCausation: () => undefined,
    run<R>(fn: () => R): R {
      lifecycle.push(`${name}.run`);
      return fn();
    },
  };
}
