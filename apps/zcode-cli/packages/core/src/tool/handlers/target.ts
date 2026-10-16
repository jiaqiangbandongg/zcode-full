// ============================================================
// Goal Tool Handlers
// ============================================================

import {
  CoreErrorType,
  GoalReadInputJsonSchema,
  GoalReadInputSchema,
  GoalReadOutputJsonSchema,
  GoalReadOutputSchema,
  createCoreError,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler, ToolExecutionContext } from "../types.js";

const MAX_GOAL_MODEL_BYTES = 100_000;

export const targetReadHandler: ToolHandler = async (input, context) => {
  GoalReadInputSchema.parse(input);
  assertTargetStore(context, "GoalRead");

  return {
    goal: await context.sessionStore.readTarget({ sessionID: context.sessionId }),
  };
};

export const targetReadToolEntry: ToolEntry = {
  capability: "Read the current session goal without modifying external state",
  metadata: {
    name: "GoalRead",
    description: "Read the current session goal and status.",
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 30000,
    maxOutputBytes: MAX_GOAL_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: targetReadHandler,
  inputSchema: GoalReadInputJsonSchema,
  outputSchema: GoalReadOutputJsonSchema,
  runtimeInputSchema: GoalReadInputSchema,
  runtimeOutputSchema: GoalReadOutputSchema,
  permission: {
    permission: "target.read",
    reason: "GoalRead only reads session-local goal state",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: targetResultBudget(),
  timeout: targetTimeout(),
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "GoalRead was cancelled before goal state was returned",
  },
  trace: targetTracePolicy(),
};

function assertTargetStore(
  context: ToolExecutionContext,
  toolName: "GoalRead",
): asserts context is ToolExecutionContext & { sessionStore: NonNullable<ToolExecutionContext["sessionStore"]> } {
  if (context.sessionStore) return;

  throw createCoreError(CoreErrorType.ConfigurationError, `SessionStorePort is not configured for ${toolName}`, {
    context: {
      toolCallId: context.toolCallId,
      toolName,
    },
    recoverable: false,
  });
}

function targetResultBudget() {
  return {
    maxInlineBytes: MAX_GOAL_MODEL_BYTES,
    maxModelBytes: MAX_GOAL_MODEL_BYTES,
    strategy: "truncate" as const,
    preview: {
      maxBytes: MAX_GOAL_MODEL_BYTES,
      direction: "head" as const,
    },
  };
}

function targetTimeout() {
  return {
    defaultMs: 30000,
    maxMs: 30000,
    allowCallOverride: false,
  };
}

function targetTracePolicy() {
  return {
    required: true as const,
    propagateToAdapters: false,
    recordInput: "summary" as const,
    recordOutput: "summary" as const,
  };
}
