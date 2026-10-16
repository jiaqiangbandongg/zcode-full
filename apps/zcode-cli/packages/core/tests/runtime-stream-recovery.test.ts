import { describe, expect, it } from "vitest";
import {
  ModelTransportKind,
  SessionEventType,
  createSessionId,
  createTraceId,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelSelection } from "./test-model-selection.js";
import {
  createTestModelFactory,
  type TestModelExecutionObservation,
} from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

type ReasoningFailureKind = "idle-timeout" | "network-reset";

function createReasoningFailure(kind: ReasoningFailureKind): Error {
  const error = new Error(
    kind === "idle-timeout"
      ? "Model stream stalled: no event received before the idle timeout."
      : "Provider stream failed with ECONNRESET.",
  ) as Error & { code?: string; context?: Record<string, unknown> };
  error.code = kind === "idle-timeout" ? "model_request_timeout" : "model_network_error";
  error.context = {
    reason: kind === "idle-timeout" ? "stream_idle_timeout" : "network_error",
    retryable: true,
  };
  return error;
}

async function publishModelNetworkStatus(
  observation: TestModelExecutionObservation,
  event: Record<string, unknown>,
): Promise<void> {
  await observation.invocationContext?.statusSink?.publish({
    attempt: 1,
    maxAttempts: 1,
    providerId: String(observation.model.providerId),
    modelId: String(observation.model.modelId),
    requestId: event.requestId,
    timestamp: new Date().toISOString(),
    traceId:
      observation.invocationContext?.traceContext?.traceId ??
      createTraceId("reasoning-recovery-test"),
    transport: ModelTransportKind.Sse,
    ...event,
  });
}

describe("AgentRuntime reasoning-only stream recovery", () => {
  it.each<ReasoningFailureKind>(["idle-timeout", "network-reset"])(
    "recovers from a retryable %s after visible reasoning without text or tools",
    async (failureKind) => {
      const sessionId = createSessionId(`reasoning-only-recovery-${failureKind}`);
      const eventStore = createTestSessionEventStore();
      let modelCallCount = 0;
      let recoveryRequest: any;
      let recoveryObservation: TestModelExecutionObservation | undefined;

      const runtime = createTestAgentRuntime(
        sessionId,
        {
          mode: "yolo",
          modelSelection: createTestModelSelection("test/reasoning-recovery"),
          modelStreaming: "on",
        },
        {
          eventStore,
          modelFactory: createTestModelFactory({
            async generateText() {
              throw new Error("streaming path expected");
            },
            async *streamText(request: any, observation) {
              modelCallCount += 1;
              if (modelCallCount === 1) {
                await publishModelNetworkStatus(observation, {
                  requestId: `reasoning-${failureKind}-1`,
                  type: "model_request_started",
                });
                yield { type: "reasoning_start", id: "reasoning-failed" };
                yield {
                  type: "reasoning_delta",
                  id: "reasoning-failed",
                  text: "unfinished reasoning",
                };
                const error = createReasoningFailure(failureKind);
                await publishModelNetworkStatus(observation, {
                  message: error.message,
                  reason: error.context?.reason,
                  requestId: `reasoning-${failureKind}-1`,
                  retryable: true,
                  type: "model_request_failed",
                });
                throw error;
              }

              recoveryRequest = request;
              recoveryObservation = observation;
              await publishModelNetworkStatus(observation, {
                requestId: `reasoning-${failureKind}-2`,
                type: "model_request_started",
              });
              yield { type: "reasoning_start", id: "reasoning-recovered" };
              yield {
                type: "reasoning_delta",
                id: "reasoning-recovered",
                text: "fresh reasoning",
              };
              yield { type: "reasoning_end", id: "reasoning-recovered" };
              yield { type: "text_delta", text: "recovered answer" };
              yield {
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            },
          } as never),
        },
      );

      const result = await runtime.executeTurn("recover reasoning-only stream");
      const events = await eventStore.getEvents(sessionId);
      const discardedTail = events.find(
        (event) => event.type === SessionEventType.StreamRecoveryTailDiscarded,
      )?.payload as Record<string, unknown> | undefined;
      const reasoningAssistantIds = events
        .filter((event) => event.type === SessionEventType.ModelStreaming)
        .map((event) => event.payload as any)
        .filter((payload) => payload.kind === "reasoning_delta")
        .map((payload) => payload.assistantMessageId);

      expect(result.response).toBe("recovered answer");
      expect(modelCallCount).toBe(2);
      expect(recoveryObservation?.invocationContext?.streamIdleTimeoutRetryNumber).toBe(1);
      expect(
        recoveryRequest.messages.filter((message: any) => message.role === "assistant"),
      ).toEqual([]);
      expect(recoveryObservation?.invocationContext?.streamRecovery).toMatchObject({
        recoveredFromRequestId: `reasoning-${failureKind}-1`,
        retryNumber: 1,
        maxRetries: 10,
      });
      expect(discardedTail).toMatchObject({
        discardedReasoningBytes: new TextEncoder().encode("unfinished reasoning").byteLength,
        discardedTextBytes: 0,
        discardedToolCallIds: [],
      });
      expect(new Set(reasoningAssistantIds).size).toBe(2);
    },
  );
});
