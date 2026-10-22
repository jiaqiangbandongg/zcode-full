import {
  CoreErrorType,
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  RespondToCoordinatorInputJsonSchema,
  RespondToCoordinatorInputSchema,
  RespondToCoordinatorOutputSchema,
  createCoreError,
  type RespondToCoordinatorInput,
  type RespondToCoordinatorOutput,
  type TraceContext,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_RESPOND_TO_COORDINATOR_MODEL_BYTES = 4_096;

const RESPOND_TO_COORDINATOR_PROVIDER_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

const respondToCoordinatorHandler: ToolHandler = async (input, context) => {
  const parsed = RespondToCoordinatorInputSchema.parse(input) as RespondToCoordinatorInput;

  if (context.runtimeScope !== "subagent" || !context.coordinatorResponsePort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Coordinator response port is not configured for RespondToCoordinator",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: RESPOND_TO_COORDINATOR_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  return context.coordinatorResponsePort.respond({
    childToolCallId: context.toolCallId,
    summary: parsed.summary,
    message: parsed.message,
    trace: resolveToolTraceContext(context),
  }) satisfies RespondToCoordinatorOutput;
};

export const respondToCoordinatorToolEntry: ToolEntry = {
  capability: "Respond to the coordinator that owns this subagent",
  metadata: {
    shouldDefer: true,
    name: RESPOND_TO_COORDINATOR_TOOL_NAME,
    description: "Respond to the coordinator that owns this subagent.",
    modelInstructions: [
      'When you receive "The coordinator sent a message while you were working:" (or the legacy "Message from coordinator:" prefix), use this tool to answer it.',
      "Use this tool for a concise response or progress update to the coordinator.",
      "When replying while work remains, do not use assistant text as the reply.",
      "Place this call before or alongside the next work tool call when possible.",
      "Continue the current task unless the coordinator explicitly changed or ended it.",
      "Do not use this tool as a substitute for the final task result.",
    ],
    allowedInPlanMode: true,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10_000,
    maxOutputBytes: MAX_RESPOND_TO_COORDINATOR_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: respondToCoordinatorHandler,
  formatModelContent: formatRespondToCoordinatorModelContent,
  inputSchema: RespondToCoordinatorInputJsonSchema,
  outputSchema: RESPOND_TO_COORDINATOR_PROVIDER_OUTPUT_SCHEMA,
  runtimeInputSchema: RespondToCoordinatorInputSchema,
  runtimeOutputSchema: RespondToCoordinatorOutputSchema,
  permission: {
    permission: "agent.message.respond",
    reason: "RespondToCoordinator writes a message to the parent runtime queue",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_RESPOND_TO_COORDINATOR_MODEL_BYTES,
    maxModelBytes: MAX_RESPOND_TO_COORDINATOR_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_RESPOND_TO_COORDINATOR_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 10_000,
    maxMs: 10_000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "RespondToCoordinator was cancelled before delivery status returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatRespondToCoordinatorModelContent(output: unknown): string {
  const result = RespondToCoordinatorOutputSchema.parse(output);
  const continuation =
    "Continue the current task unless the coordinator explicitly changed or ended it.";
  if (result.status === "success") {
    return `Response ${result.responseId} was queued for the coordinator. ${continuation}`;
  }
  // 错误详情无长度上限，continuation 必须放在它之前，避免 resultBudget 截断关键指引。
  return `Response ${result.responseId} failed to queue for the coordinator. ${continuation} Failure: ${result.error ?? result.message}.`;
}

function resolveToolTraceContext(context: Parameters<ToolHandler>[1]): TraceContext {
  return (
    context.traceContext ?? {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    }
  );
}
