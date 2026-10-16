import { context, type Context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadWriteSpan,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTelemetryCausation } from "@zcode/contracts/telemetry";
import { AgentExecutionTelemetryRuntime } from "../src/agent-trace-runtime.js";
import type {
  AgentMetricSpanName,
  AgentTelemetryMetricRecorder,
  ModelTokenType,
} from "../src/agent-metrics.js";

interface Harness {
  activeSpans: Map<string, ReadWriteSpan>;
  exporter: InMemorySpanExporter;
  provider: BasicTracerProvider;
  runtime: AgentExecutionTelemetryRuntime;
}

let contextManager: AsyncLocalStorageContextManager;
let harnesses: Harness[] = [];

beforeEach(() => {
  context.disable();
  contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
});

afterEach(async () => {
  for (const harness of harnesses) await harness.provider.shutdown();
  harnesses = [];
  context.disable();
  contextManager.disable();
});

describe("AgentExecutionTelemetryRuntime V5", () => {
  it("为 Auto Compact 记录触发时的上下文预算事实", () => {
    const harness = createHarness();
    const compaction = harness.runtime.startCompaction({
      maxAttempts: 3,
      modelMode: "streaming",
      phase: "pre_request",
      policyContextWindowTokens: 128_000,
      thresholdTokens: 94_000,
      tokenSource: "provider_usage",
      trigger: "auto",
    });

    compaction.setInputTokens(94_001);

    expect(harness.activeSpans.get("context_compaction")?.attributes).toMatchObject({
      "zcode.context_compaction.input_tokens": 94_001,
      "zcode.context_compaction.policy_context_window_tokens": 128_000,
      "zcode.context_compaction.threshold_tokens": 94_000,
      "zcode.context_compaction.token_source": "provider_usage",
    });

    compaction.finishCompleted();
  });

  it("创建稳定的 Turn -> Step -> Tool -> Command 拓扑，并由事实源写终态", async () => {
    const harness = createHarness();
    const turn = harness.runtime.startTurn({
      context: executionContext(),
      inputSource: "user",
      turnNumber: 3,
    });

    await turn.run(async () => {
      const step = harness.runtime.startStep({ stepId: "step-1", stepIndex: 0 });
      await step.run(async () => {
        const tool = harness.runtime.startTool({
          registeredToolName: "Bash",
          toolCallId: "tool-1",
        });
        await tool.run(async () => {
          tool.markPermissionRequested();
          tool.setPermissionDecision("granted");
          const command = tool.startCommand({
            category: "git",
            commandCount: 1,
            safeName: "git",
            sandboxed: true,
            shellKind: "bash",
          });
          await command.run(async () => {
            command.markFirstOutput();
            command.setExitCode(0);
            command.setOutputBytes(42);
            command.finishCompleted();
          });
          tool.setOutputBytes(42);
          tool.setOutputTruncated(false);
          tool.finishCompleted();
        });
        step.finishCompleted("tool_requested");
      });
      turn.finishCompleted("assistant_message");
    });

    const spans = harness.exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual([
      "command_execution",
      "tool_execution",
      "agent_step",
      "agent_turn",
    ]);
    expect(parentName(spans, "command_execution")).toBe("tool_execution");
    expect(parentName(spans, "tool_execution")).toBe("agent_step");
    expect(parentName(spans, "agent_step")).toBe("agent_turn");
    expect(span(spans, "command_execution").attributes).toMatchObject({
      "zcode.command_execution.safe_name": "git",
      "zcode.command_execution.exit_code": 0,
      "process.exit.code": 0,
    });
    expect(span(spans, "tool_execution").events.map((event) => event.name)).toEqual([
      "permission_requested",
      "permission_decided",
    ]);
    expect(
      Object.keys(span(spans, "agent_turn").attributes).some((key) => key.includes("span.type")),
    ).toBe(false);
  });

  it("run 对同步/异步异常只执行一次业务回调，并自动收口缺失 terminal", async () => {
    const harness = createHarness();
    let calls = 0;
    const thrown = harness.runtime.startDetachedOperation({
      context: executionContext(),
      executionKind: "foreground",
      operation: "workspace_generate_text",
      trigger: "user",
    });

    await expect(
      thrown.run(async () => {
        calls += 1;
        throw new Error("api_key=secret user@example.com /Users/alice/file.ts");
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);

    const missing = harness.runtime.startDetachedOperation({
      context: executionContext(),
      executionKind: "foreground",
      operation: "session_title_generation",
      trigger: "turn",
    });
    await missing.run(async () => "done");

    const spans = harness.exporter.getFinishedSpans();
    expect(spans[0]?.attributes).toMatchObject({
      "zcode.detached_operation.outcome": "failed",
      "zcode.detached_operation.failure_stage": "unhandled",
    });
    expect(String(spans[0]?.attributes["zcode.detached_operation.error_message"])).not.toContain(
      "secret",
    );
    expect(spans[1]?.attributes).toMatchObject({
      "zcode.detached_operation.outcome": "abandoned",
      "zcode.detached_operation.abandon_reason": "missing_terminal",
    });
  });

  it("Detached 使用独立 Root + Link，且身份只投影在 Turn Root", async () => {
    const harness = createHarness();
    harness.runtime.updateIdentity({
      identityState: "authenticated",
      userSubjectId: "subject-123",
    });
    const turn = harness.runtime.startTurn({
      context: executionContext(),
      turnNumber: 1,
    });
    let causation = turn.captureCausation();
    await turn.run(async () => {
      causation = harness.runtime.captureCausation();
      turn.finishCompleted();
    });
    causation = causation
      ? {
          ...causation,
          isRemote: true,
          traceState: "vendor=value",
        }
      : causation;
    const detached = harness.runtime.startDetachedOperation({
      causation,
      context: executionContext(),
      executionKind: "background",
      operation: "project_memory_extract",
      trigger: "turn",
    });
    detached.finishCompleted();

    const spans = harness.exporter.getFinishedSpans();
    const turnSpan = span(spans, "agent_turn");
    const detachedSpan = span(spans, "detached_operation");
    expect(detachedSpan.parentSpanContext).toBeUndefined();
    expect(detachedSpan.links[0]?.context.spanId).toBe(turnSpan.spanContext().spanId);
    expect(detachedSpan.links[0]?.context.traceId).toBe(turnSpan.spanContext().traceId);
    expect(detachedSpan.links[0]?.context.traceFlags).toBe(turnSpan.spanContext().traceFlags);
    expect(detachedSpan.links[0]?.context.traceState?.serialize()).toBe("vendor=value");
    expect(detachedSpan.links[0]?.context.isRemote).toBe(true);
    expect(detachedSpan.links[0]?.attributes).toEqual({
      "zcode.link.relation": "triggered_by",
    });
    expect(turnSpan.attributes).toMatchObject({
      "zcode.execution.identity_state": "authenticated",
      "zcode.execution.user_subject_id": "subject-123",
    });
    expect(detachedSpan.attributes["zcode.execution.user_subject_id"]).toBeUndefined();
  });

  it("被调用方等待的前台 Operation 使用真实 Parent，不伪造成跨 Trace Link", async () => {
    const harness = createHarness();
    const turn = harness.runtime.startTurn({
      context: executionContext(),
      turnNumber: 1,
    });

    await turn.run(async () => {
      const operation = harness.runtime.startDetachedOperation({
        causation: harness.runtime.captureCausation(),
        context: executionContext(),
        executionKind: "foreground",
        operation: "goal_completion_verification",
        targetKind: "goal",
        trigger: "turn",
      });
      operation.finishCompleted();
      turn.finishCompleted();
    });

    const spans = harness.exporter.getFinishedSpans();
    const turnSpan = span(spans, "agent_turn");
    const operationSpan = span(spans, "detached_operation");
    expect(operationSpan.parentSpanContext?.spanId).toBe(turnSpan.spanContext().spanId);
    expect(operationSpan.spanContext().traceId).toBe(turnSpan.spanContext().traceId);
    expect(operationSpan.links).toHaveLength(0);
  });

  it("显式 Causation 不会被执行时另一个 Active Context 覆盖", async () => {
    const harness = createHarness();
    const sourceTurn = harness.runtime.startTurn({
      context: { ...executionContext(), sessionId: "session-source" },
      turnNumber: 1,
    });
    const causation = sourceTurn.captureCausation();
    sourceTurn.finishCompleted();

    const unrelatedTurn = harness.runtime.startTurn({
      context: { ...executionContext(), sessionId: "session-unrelated" },
      turnNumber: 1,
    });
    await unrelatedTurn.run(async () => {
      const operation = harness.runtime.startDetachedOperation({
        causation,
        context: { ...executionContext(), sessionId: "session-child" },
        executionKind: "foreground",
        operation: "workspace_generate_text",
        trigger: "user",
      });
      operation.finishCompleted();
      unrelatedTurn.finishCompleted();
    });

    const spans = harness.exporter.getFinishedSpans();
    const sourceSpan = spans.find(
      (candidate) =>
        candidate.name === "agent_turn" &&
        candidate.attributes["zcode.execution.session_id"] === "session-source",
    );
    const unrelatedSpan = spans.find(
      (candidate) =>
        candidate.name === "agent_turn" &&
        candidate.attributes["zcode.execution.session_id"] === "session-unrelated",
    );
    const operationSpan = span(spans, "detached_operation");
    expect(operationSpan.parentSpanContext?.spanId).toBe(sourceSpan?.spanContext().spanId);
    expect(operationSpan.parentSpanContext?.spanId).not.toBe(unrelatedSpan?.spanContext().spanId);
  });

  it("前台 Subagent Turn 作为 Agent Tool 子树，后台 Subagent 使用独立 Trace + Link", async () => {
    const harness = createHarness();
    const parentTurn = harness.runtime.startTurn({
      context: executionContext(),
      turnNumber: 1,
    });
    let toolCausation: AgentTelemetryCausation | undefined;

    await parentTurn.run(async () => {
      const tool = harness.runtime.startTool({
        registeredToolName: "Agent",
        toolCallId: "tool-agent-1",
      });
      await tool.run(async () => {
        toolCausation = tool.captureCausation();
        const childTurn = harness.runtime.startTurn({
          causation: toolCausation,
          causationMode: "child",
          context: {
            actorKind: "subagent",
            agentName: "zcode-general-purpose",
            launchSurface: "desktop",
            parentSessionId: "session-1",
            sessionId: "session-child",
            turnId: "turn-child",
          },
          turnNumber: 0,
        });
        await childTurn.run(async () => {
          const childStep = harness.runtime.startStep({
            stepId: "step-child",
            stepIndex: 0,
          });
          await childStep.run(async () => {
            const call = harness.runtime.startCall({
              logicalCallId: "logical-child",
              operation: "agent_step",
              requested: {
                providerId: "provider-child",
                reasoning: {
                  capability: "supported",
                  effectiveControl: "fixed_level",
                  effectiveState: "enabled",
                  requestedControl: "fixed_level",
                  requestedState: "enabled",
                },
                requestedModel: "model-child",
              },
              streaming: true,
            });
            await call.run(async () => {
              const attempt = call.startAttempt({
                apiOperation: "messages",
                attemptCause: "initial",
                attemptNumber: 1,
                requestId: "request-child",
                target: {
                  providerId: "provider-child",
                  providerKind: "anthropic",
                  reasoning: {
                    capability: "supported",
                    effectiveControl: "fixed_level",
                    effectiveState: "enabled",
                    requestedControl: "fixed_level",
                    requestedState: "enabled",
                  },
                  requestedModel: "model-child",
                },
                transport: "sse",
              });
              attempt.finishCompleted();
              call.finishCompleted();
            });

            const childTool = harness.runtime.startTool({
              registeredToolName: "Bash",
              toolCallId: "tool-child-bash",
            });
            await childTool.run(async () => {
              const command = childTool.startCommand({
                category: "git",
                commandCount: 1,
                safeName: "git",
                sandboxed: true,
                shellKind: "bash",
              });
              command.finishCompleted();
              childTool.finishCompleted();
            });
            childStep.finishCompleted("turn_completed");
          });
          childTurn.finishCompleted("assistant_message");
        });
        tool.finishCompleted();
      });
      parentTurn.finishCompleted("tool_request");
    });

    const backgroundTurn = harness.runtime.startTurn({
      causation: toolCausation,
      causationMode: "linked_root",
      context: {
        actorKind: "subagent",
        agentName: "zcode-general-purpose",
        launchSurface: "desktop",
        parentSessionId: "session-1",
        sessionId: "session-background",
        turnId: "turn-background",
      },
      turnNumber: 0,
    });
    backgroundTurn.finishCompleted("assistant_message");

    const spans = harness.exporter.getFinishedSpans();
    const toolSpan = spans.find(
      (candidate) =>
        candidate.name === "tool_execution" &&
        candidate.attributes["zcode.execution.tool_call_id"] === "tool-agent-1",
    );
    const foregroundTurn = spans.find(
      (candidate) =>
        candidate.name === "agent_turn" &&
        candidate.attributes["zcode.execution.session_id"] === "session-child",
    );
    const foregroundStep = spans.find(
      (candidate) =>
        candidate.name === "agent_step" &&
        candidate.attributes["zcode.execution.turn_id"] === "turn-child",
    );
    const foregroundCall = spans.find(
      (candidate) =>
        candidate.name === "model_call" &&
        candidate.attributes["zcode.execution.turn_id"] === "turn-child",
    );
    const foregroundAttempt = spans.find(
      (candidate) =>
        candidate.name === "model_attempt" &&
        candidate.attributes["zcode.execution.turn_id"] === "turn-child",
    );
    const foregroundTool = spans.find(
      (candidate) =>
        candidate.name === "tool_execution" &&
        candidate.attributes["zcode.execution.tool_call_id"] === "tool-child-bash",
    );
    const foregroundCommand = spans.find(
      (candidate) =>
        candidate.name === "command_execution" &&
        candidate.attributes["zcode.execution.tool_call_id"] === "tool-child-bash",
    );
    const linkedTurn = spans.find(
      (candidate) =>
        candidate.name === "agent_turn" &&
        candidate.attributes["zcode.execution.session_id"] === "session-background",
    );
    expect(foregroundTurn?.parentSpanContext?.spanId).toBe(toolSpan?.spanContext().spanId);
    expect(foregroundTurn?.spanContext().traceId).toBe(toolSpan?.spanContext().traceId);
    expect(foregroundStep?.parentSpanContext?.spanId).toBe(foregroundTurn?.spanContext().spanId);
    expect(foregroundCall?.parentSpanContext?.spanId).toBe(foregroundStep?.spanContext().spanId);
    expect(foregroundAttempt?.parentSpanContext?.spanId).toBe(foregroundCall?.spanContext().spanId);
    expect(foregroundTool?.parentSpanContext?.spanId).toBe(foregroundStep?.spanContext().spanId);
    expect(foregroundCommand?.parentSpanContext?.spanId).toBe(foregroundTool?.spanContext().spanId);
    for (const child of [
      foregroundTurn,
      foregroundStep,
      foregroundCall,
      foregroundAttempt,
      foregroundTool,
      foregroundCommand,
    ]) {
      expect(child?.spanContext().traceId).toBe(toolSpan?.spanContext().traceId);
    }
    expect(linkedTurn?.parentSpanContext).toBeUndefined();
    expect(linkedTurn?.links[0]?.context.spanId).toBe(toolSpan?.spanContext().spanId);
    expect(linkedTurn?.links[0]?.attributes).toEqual({
      "zcode.link.relation": "spawned_by",
    });
  });

  it("Tool 与 Command 不共享退出码语义，非命令 Tool 不产生 exit code", () => {
    const harness = createHarness();
    const tool = harness.runtime.startTool({
      registeredToolName: "Read",
      toolCallId: "tool-read",
    });
    tool.finishCompleted();
    const toolSpan = span(harness.exporter.getFinishedSpans(), "tool_execution");
    expect(toolSpan.attributes["zcode.tool_execution.exit_code"]).toBeUndefined();
    expect(toolSpan.attributes["process.exit.code"]).toBeUndefined();
  });

  it("显式失败接口保留清洗后的错误归因", () => {
    const harness = createHarness();
    const error = Object.assign(new Error("authorization: Bearer private-token user@example.com"), {
      code: "E_PROVIDER",
    });
    const turn = harness.runtime.startTurn({
      context: executionContext(),
      turnNumber: 1,
    });
    turn.finishFailed("agent_loop", "provider", error);

    expect(span(harness.exporter.getFinishedSpans(), "agent_turn").attributes).toMatchObject({
      "zcode.agent_turn.error_category": "provider",
      "zcode.agent_turn.error_code": "E_PROVIDER",
      "zcode.agent_turn.error_type": "Error",
      "zcode.agent_turn.outcome": "failed",
    });
    const message = String(
      span(harness.exporter.getFinishedSpans(), "agent_turn").attributes[
        "zcode.agent_turn.error_message"
      ],
    );
    expect(message).not.toContain("private-token");
    expect(message).not.toContain("user@example.com");
    expect(span(harness.exporter.getFinishedSpans(), "agent_turn").attributes).not.toHaveProperty(
      "error.cause.message",
    );
  });

  it("同一源异常只在最靠近来源的 Span 记录一次正文", () => {
    const harness = createHarness();
    const networkCause = Object.assign(
      new Error("socket reset authorization: Bearer secret-token"),
      { code: "ECONNRESET" },
    );
    const source = Object.assign(
      new Error("provider request req-raw-123 failed", { cause: networkCause }),
      {
        code: "E_PROVIDER",
      },
    );
    const call = harness.runtime.startCall({
      logicalCallId: "logical-error",
      operation: "agent_step",
      requested: {
        providerId: "provider-1",
        reasoning: {
          capability: "supported",
          effectiveControl: "fixed_level",
          effectiveState: "enabled",
          requestedControl: "fixed_level",
          requestedState: "enabled",
        },
        requestedModel: "claude-test",
      },
      streaming: true,
    });
    const attempt = call.startAttempt({
      apiOperation: "messages",
      attemptCause: "initial",
      attemptNumber: 1,
      requestId: "request-error",
      target: {
        providerId: "provider-1",
        providerKind: "anthropic",
        reasoning: {
          capability: "supported",
          effectiveControl: "fixed_level",
          effectiveState: "enabled",
          requestedControl: "fixed_level",
          requestedState: "enabled",
        },
        requestedModel: "claude-test",
      },
      transport: "sse",
    });

    attempt.finishFailed("response", "provider", source);
    call.finishFailed("attempts", "provider", new Error("classified wrapper", { cause: source }));

    const spans = harness.exporter.getFinishedSpans();
    expect(span(spans, "model_attempt").attributes).toMatchObject({
      "zcode.model_attempt.error_code": "E_PROVIDER",
      "zcode.model_attempt.error_message": "provider request req-raw-123 failed",
      "error.cause.code": "ECONNRESET",
      "error.cause.type": "Error",
      "error.cause.message": "socket reset authorization: {redacted}",
    });
    expect(span(spans, "model_call").attributes).toMatchObject({
      "zcode.model_call.failure_stage": "attempts",
      "zcode.model_call.outcome": "failed",
    });
    expect(span(spans, "model_call").attributes).not.toHaveProperty(
      "zcode.model_call.error_message",
    );
    expect(span(spans, "model_call").attributes).not.toHaveProperty("error.cause.message");
  });

  it("活动 Writer 达到容量时旁路新 Span，不阻塞业务", () => {
    const harness = createHarness({ maxActiveWriters: 1 });
    const first = harness.runtime.startTurn({
      context: executionContext(),
      turnNumber: 1,
    });
    const second = harness.runtime.startTurn({
      context: executionContext(),
      turnNumber: 2,
    });

    expect(second.run(() => "business-result")).toBe("business-result");
    harness.runtime.abandonSession("session-1");
    expect(harness.exporter.getFinishedSpans()).toHaveLength(1);
    expect(harness.exporter.getFinishedSpans()[0]?.attributes).toMatchObject({
      "zcode.agent_turn.abandon_reason": "session_shutdown",
    });
    first.finishCompleted();
  });

  it("原始 usage 只写 Attempt，父 Span 不复制无必要聚合", async () => {
    const harness = createHarness();
    const turn = harness.runtime.startTurn({
      context: executionContext(),
      turnNumber: 1,
    });

    await turn.run(async () => {
      const call = harness.runtime.startCall({
        logicalCallId: "logical-1",
        operation: "agent_step",
        requested: {
          providerId: "provider-1",
          reasoning: {
            capability: "supported",
            effectiveControl: "fixed_level",
            effectiveState: "enabled",
            requestedControl: "fixed_level",
            requestedState: "enabled",
          },
          requestedModel: "claude-test",
        },
        streaming: true,
      });
      const attempt = call.startAttempt({
        apiOperation: "messages",
        attemptCause: "initial",
        attemptNumber: 1,
        requestId: "request-1",
        target: {
          providerId: "provider-1",
          providerKind: "anthropic",
          reasoning: {
            capability: "supported",
            effectiveControl: "fixed_level",
            effectiveState: "enabled",
            requestedControl: "fixed_level",
            requestedState: "enabled",
          },
          requestedModel: "claude-test",
        },
        transport: "sse",
      });

      attempt.setInputTokens(12);
      attempt.setOutputTokens(4);

      expect(harness.activeSpans.get("model_attempt")?.attributes).toMatchObject({
        "zcode.model_attempt.input_tokens": 12,
        "zcode.model_attempt.output_tokens": 4,
      });
      expect(harness.activeSpans.get("model_call")?.attributes).not.toHaveProperty(
        "zcode.model_call.provider_input_tokens_total",
      );
      expect(harness.activeSpans.get("agent_turn")?.attributes).not.toHaveProperty(
        "zcode.agent_turn.provider_input_tokens_total",
      );

      attempt.finishCompleted();
      call.finishCompleted();
      turn.finishCompleted();
    });
  });

  it("missing terminal 和进程回收仍会输出终态明细 Metric", async () => {
    const metrics = new RecordingMetrics();
    const harness = createHarness({ metrics });
    const turn = harness.runtime.startTurn({
      context: executionContext(),
      turnNumber: 1,
    });

    await turn.run(async () => {
      const call = harness.runtime.startCall({
        logicalCallId: "logical-abandoned",
        operation: "agent_step",
        requested: {
          providerId: "provider-1",
          reasoning: {
            capability: "supported",
            effectiveControl: "fixed_level",
            effectiveState: "enabled",
            requestedControl: "fixed_level",
            requestedState: "enabled",
          },
          requestedModel: "claude-test",
        },
        streaming: true,
      });
      await call.run(async () => {
        const attempt = call.startAttempt({
          apiOperation: "messages",
          attemptCause: "initial",
          attemptNumber: 1,
          requestId: "request-abandoned",
          target: {
            providerId: "provider-1",
            providerKind: "anthropic",
            reasoning: {
              capability: "supported",
              effectiveControl: "fixed_level",
              effectiveState: "enabled",
              requestedControl: "fixed_level",
              requestedState: "enabled",
            },
            requestedModel: "claude-test",
          },
          transport: "sse",
        });
        await attempt.run(async () => {
          attempt.markFirstContent();
        });
        call.finishCompleted();
      });
      turn.finishCompleted();
    });

    expect(metrics.modelAttemptDetails).toHaveLength(1);
    expect(metrics.modelAttemptDetails[0]).toMatchObject({
      labels: { outcome: "abandoned" },
    });
  });
});

function createHarness(
  options: {
    maxActiveWriters?: number;
    metrics?: AgentTelemetryMetricRecorder;
  } = {},
): Harness {
  const exporter = new InMemorySpanExporter();
  const inspector = new InspectingSpanProcessor();
  const provider = new BasicTracerProvider({
    spanProcessors: [inspector, new SimpleSpanProcessor(exporter)],
  });
  const runtime = new AgentExecutionTelemetryRuntime({
    maxActiveWriters: options.maxActiveWriters,
    metrics: options.metrics,
    tracer: provider.getTracer("test"),
  });
  const harness = { activeSpans: inspector.activeSpans, exporter, provider, runtime };
  harnesses.push(harness);
  return harness;
}

class RecordingMetrics implements AgentTelemetryMetricRecorder {
  readonly modelAttemptDetails: Array<{
    detail: {
      firstContentMs?: number;
      firstProviderEventMs?: number;
      firstTextMs?: number;
      stallCount: number;
      streamMaxIdleMs: number;
    };
    labels: Record<string, unknown>;
  }> = [];

  recordCommandFirstOutput() {}
  recordCreationDrop() {}
  recordModelCallAttempts() {}
  recordModelTokenDelta(_tokenType: ModelTokenType) {}
  recordSpanTerminal(_spanName: AgentMetricSpanName) {}

  recordModelAttemptDetail(
    labels: Record<string, unknown>,
    detail: {
      firstContentMs?: number;
      firstProviderEventMs?: number;
      firstTextMs?: number;
      stallCount: number;
      streamMaxIdleMs: number;
    },
  ): void {
    this.modelAttemptDetails.push({ detail, labels });
  }
}

class InspectingSpanProcessor implements SpanProcessor {
  readonly activeSpans = new Map<string, ReadWriteSpan>();

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  onEnd(span: ReadableSpan): void {
    this.activeSpans.delete(span.name);
  }

  onStart(span: ReadWriteSpan, _parentContext: Context): void {
    this.activeSpans.set(span.name, span);
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function executionContext() {
  return {
    actorKind: "main" as const,
    launchSurface: "desktop" as const,
    queryId: "query-1",
    sessionId: "session-1",
    turnId: "turn-1",
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
