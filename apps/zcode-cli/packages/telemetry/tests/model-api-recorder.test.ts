import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ModelFailureReason,
  ModelTransportKind,
  type ModelNetworkStatusEvent,
} from "@zcode/contracts/model";
import { AgentExecutionTelemetryRuntime } from "../src/agent-trace-runtime.js";
import { ModelApiTelemetryStatusSink } from "../src/model-api-recorder.js";

let manager: AsyncLocalStorageContextManager;
let provider: BasicTracerProvider;
let exporter: InMemorySpanExporter;

beforeEach(() => {
  context.disable();
  manager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
});

afterEach(async () => {
  await provider.shutdown();
  context.disable();
  manager.disable();
});

describe("ModelApiTelemetryStatusSink V5", () => {
  it("创建 Model Call -> Attempt，并记录目标、reasoning、usage 与实时里程碑", async () => {
    const runtime = new AgentExecutionTelemetryRuntime({
      tracer: provider.getTracer("test"),
    });
    const sink = new ModelApiTelemetryStatusSink({ modelExecution: runtime });
    const turn = runtime.startTurn({
      context: {
        actorKind: "main",
        launchSurface: "desktop",
        sessionId: "session-1",
        turnId: "turn-1",
      },
      turnNumber: 1,
    });

    await turn.run(async () => {
      const step = runtime.startStep({ stepId: "step-1", stepIndex: 0 });
      await step.run(async () => {
        sink.publish({ ...baseEvent(), type: "model_request_started" });
        sink.publish({
          ...baseEvent(),
          elapsedMs: 4,
          type: "model_first_provider_event",
        });
        sink.publish({ ...baseEvent(), elapsedMs: 8, type: "model_first_content" });
        sink.publish({ ...baseEvent(), elapsedMs: 9, type: "model_first_text" });
        sink.publish({
          ...baseEvent(),
          durationMs: 12,
          finishReason: "stop",
          type: "model_request_completed",
          usage: {
            cacheReadTokens: 3,
            cacheWriteTokens: 2,
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 1,
          },
        });
        step.finishCompleted("model_completed");
      });
      turn.finishCompleted("assistant_message");
    });

    const spans = exporter.getFinishedSpans();
    expect(parentName(spans, "model_attempt")).toBe("model_call");
    expect(parentName(spans, "model_call")).toBe("agent_step");
    expect(span(spans, "model_call").attributes).not.toHaveProperty("zcode.model_call.model_role");
    expect(span(spans, "model_attempt").attributes).toMatchObject({
      "zcode.model_attempt.provider_kind": "anthropic",
      "zcode.model_attempt.provider_origin": "https://proxy.example.com",
      "zcode.model_attempt.provider_route": "/tenant/{id}/v1/messages",
      "zcode.model_attempt.requested_model": "anthropic/claude-sonnet",
      "zcode.model_attempt.reasoning_effective_state": "enabled",
      "zcode.model_attempt.cache_read_tokens": 3,
      "zcode.model_attempt.cache_write_tokens": 2,
      "zcode.model_attempt.input_tokens": 10,
      "zcode.model_attempt.output_tokens": 5,
    });
    expect(span(spans, "model_attempt").events.map((event) => event.name)).toEqual([
      "first_provider_event",
      "first_content",
      "first_text",
    ]);
    expect(span(spans, "model_call").attributes).toMatchObject({
      "zcode.model_call.outcome": "completed",
    });
    expect(span(spans, "agent_turn").attributes).not.toHaveProperty(
      "zcode.agent_turn.provider_input_tokens_total",
    );
  });

  it("保留 retry attempt、原始 provider 错误事实和脱敏后的 thrown error", () => {
    const runtime = new AgentExecutionTelemetryRuntime({
      tracer: provider.getTracer("test"),
    });
    const sink = new ModelApiTelemetryStatusSink({ modelExecution: runtime });
    sink.publish({ ...baseEvent(), type: "model_request_started" });
    sink.publishFailure(
      {
        ...baseEvent(),
        durationMs: 10,
        errorCode: "MODEL_RATE_LIMITED" as never,
        errorPhase: "response",
        message: "failed?api_key=secret user@example.com",
        providerErrorCode: "E429",
        providerErrorMessage: "authorization: Bearer secret-token",
        reason: ModelFailureReason.RateLimited,
        retryable: true,
        statusCode: 429,
        type: "model_request_failed",
      },
      Object.assign(
        new Error("socket reset upstream request=req-42 authorization: Bearer secret-token"),
        { code: "ECONNRESET" },
      ),
    );
    sink.publish({
      ...baseEvent(),
      delayMs: 25,
      message: "retry",
      nextAttempt: 2,
      reason: "rate_limit",
      type: "model_retry_scheduled",
    });
    sink.publish({
      ...baseEvent(),
      attempt: 2,
      requestId: "request-2",
      type: "model_request_started",
    });
    sink.publish({
      ...baseEvent(),
      attempt: 2,
      durationMs: 20,
      requestId: "request-2",
      type: "model_request_completed",
      usage: { inputTokens: 2, outputTokens: 1 },
    });

    const attempts = exporter
      .getFinishedSpans()
      .filter((candidate) => candidate.name === "model_attempt");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.attributes).toMatchObject({
      "zcode.model_attempt.error_code": "ECONNRESET",
      "zcode.model_attempt.http_status_code": 429,
      "zcode.model_attempt.provider_error_code": "E429",
      "zcode.model_attempt.provider_error_message": "authorization: {redacted}",
      "zcode.model_attempt.outcome": "failed",
    });
    expect(String(attempts[0]?.attributes["zcode.model_attempt.error_message"])).not.toContain(
      "secret",
    );
    expect(String(attempts[0]?.attributes["zcode.model_attempt.error_message"])).toContain(
      "socket reset upstream request=req-42",
    );
    expect(attempts[1]?.attributes).toMatchObject({
      "zcode.model_attempt.attempt_cause": "retry",
      "zcode.model_attempt.retry_delay_ms": 25,
      "zcode.model_attempt.previous_request_id": "request-1",
    });
    const modelCall = span(exporter.getFinishedSpans(), "model_call");
    expect(modelCall.attributes).not.toHaveProperty("zcode.model_call.had_error");
    expect(modelCall.attributes).not.toHaveProperty("zcode.model_call.error_message");
  });

  it("Session 关闭时释放仍未收到终态事件的 model call 索引", () => {
    const runtime = new AgentExecutionTelemetryRuntime({
      tracer: provider.getTracer("test"),
    });
    const sink = new ModelApiTelemetryStatusSink({ modelExecution: runtime });
    sink.publish({
      ...baseEvent(),
      sessionId: "session-1" as never,
      type: "model_request_started",
    });

    expect(sink.activeCallCount).toBe(1);
    runtime.abandonSession("session-1");
    sink.abandonSession("session-1");
    expect(sink.activeCallCount).toBe(0);
  });

  it("惰性清理长期没有终态的 model call 和 attempt", () => {
    let now = 0;
    const runtime = new AgentExecutionTelemetryRuntime({
      tracer: provider.getTracer("test"),
    });
    const sink = new ModelApiTelemetryStatusSink({
      maxActiveCallAgeMs: 100,
      modelExecution: runtime,
      now: () => now,
    });
    sink.publish({ ...baseEvent(), type: "model_request_started" });

    now = 101;
    sink.publish({
      ...baseEvent(),
      modelCall: {
        ...baseEvent().modelCall,
        logicalCallId: "logical-2",
      },
      requestId: "request-2",
      sessionId: "session-2" as never,
      type: "model_request_started",
    });

    expect(sink.activeCallCount).toBe(1);
    const abandoned = exporter
      .getFinishedSpans()
      .filter((candidate) => candidate.attributes["zcode.model_call.outcome"] === "abandoned");
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]?.attributes).toMatchObject({
      "zcode.model_call.abandon_reason": "missing_terminal",
    });
  });

  it("容量保护淘汰最久未活动的 call，且 Session 清理互不影响", () => {
    let now = 0;
    const warnings: string[] = [];
    const runtime = new AgentExecutionTelemetryRuntime({
      tracer: provider.getTracer("test"),
    });
    const sink = new ModelApiTelemetryStatusSink({
      maxActiveCalls: 1,
      modelExecution: runtime,
      now: () => now,
      onWarning: (message) => warnings.push(message),
    });
    sink.publish({
      ...baseEvent(),
      sessionId: "session-1" as never,
      type: "model_request_started",
    });

    now = 1;
    sink.publish({
      ...baseEvent(),
      modelCall: {
        ...baseEvent().modelCall,
        logicalCallId: "logical-2",
      },
      requestId: "request-2",
      sessionId: "session-2" as never,
      type: "model_request_started",
    });
    expect(sink.activeCallCount).toBe(1);

    now = 2;
    sink.publish({
      ...baseEvent(),
      modelCall: {
        ...baseEvent().modelCall,
        logicalCallId: "logical-3",
      },
      requestId: "request-3",
      sessionId: "session-3" as never,
      type: "model_request_started",
    });
    expect(warnings).toEqual(["Model telemetry active call capacity was reached"]);

    sink.abandonSession("session-1");
    expect(sink.activeCallCount).toBe(1);
    sink.abandonSession("session-3");
    expect(sink.activeCallCount).toBe(0);
    expect(
      exporter.getFinishedSpans().filter((candidate) => candidate.name === "model_call"),
    ).toHaveLength(3);
  });
});

function baseEvent(): Omit<ModelNetworkStatusEvent, "type"> & {
  modelCall: NonNullable<ModelNetworkStatusEvent["modelCall"]>;
} {
  return {
    attempt: 1,
    baseURL: "https://proxy.example.com/tenant/123456789/v1/messages?api_key=never-export",
    maxAttempts: 2,
    modelId: "anthropic/claude-sonnet" as never,
    modelCall: {
      actorKind: "main",
      logicalCallId: "logical-1",
      operation: "agent_step",
      reasoning: {
        capability: "supported",
        effectiveControl: "fixed_level",
        effectiveLevel: "high",
        effectiveState: "enabled",
        requestedControl: "fixed_level",
        requestedLevel: "high",
        requestedState: "enabled",
      },
    },
    providerKind: "anthropic",
    providerId: "anthropic-prod" as never,
    requestId: "request-1",
    timestamp: new Date().toISOString(),
    traceId: "trace-1" as never,
    transport: ModelTransportKind.Sse,
  };
}

function span(spans: ReadableSpan[], name: string): ReadableSpan {
  const found = spans.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing ${name}`);
  return found;
}

function parentName(spans: ReadableSpan[], childName: string): string | undefined {
  const child = span(spans, childName);
  return spans.find(
    (candidate) => candidate.spanContext().spanId === child.parentSpanContext?.spanId,
  )?.name;
}
