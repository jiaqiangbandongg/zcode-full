import { SessionEventType } from "../deps.js";
import type { ModelToolCall, TraceContext } from "../deps.js";
import {
  buildRepeatedToolCallReminderBody,
  buildToolCallBudgetReminderBody,
  detectRepeatedToolCallWarnings,
  detectToolCallBudgetWarning,
} from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { systemReminderAttachmentEntry, toModelToolCall } from "../../agent/message-history.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";

export async function handleToolCallAnomalyWarnings(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    modelTraceContext: TraceContext;
    toolCalls: ModelToolCall[];
  },
): Promise<void> {
  const budgetWarning = detectToolCallBudgetWarning(
    state.toolCallCount,
    options.toolCalls.length,
    state,
    runtime.config.modelAnomalyGuard,
  );
  if (budgetWarning) {
    if (budgetWarning.warningInjected) {
      commitTurnRequestEntries(runtime, state.turnRequestState, [
        systemReminderAttachmentEntry(
          "model_anomaly",
          buildToolCallBudgetReminderBody(budgetWarning.observedCount),
        ),
      ]);
    }
    const warningEvent = runtime.createEvent(
      SessionEventType.ModelAnomalyWarning,
      {
        category: "tool_call_budget",
        severity: "warning",
        observedCount: budgetWarning.observedCount,
        threshold: budgetWarning.threshold,
        warningInjected: budgetWarning.warningInjected,
      },
      options.modelTraceContext,
    );
    await runtime.appendEvent(warningEvent, options.modelTraceContext);
    state.events.push(warningEvent);
  }

  const repeatedWarnings = detectRepeatedToolCallWarnings(
    options.toolCalls.map(toModelToolCall),
    state,
    runtime.config.modelAnomalyGuard,
  );
  for (const warning of repeatedWarnings) {
    if (warning.warningInjected) {
      commitTurnRequestEntries(runtime, state.turnRequestState, [
        systemReminderAttachmentEntry(
          "model_anomaly",
          buildRepeatedToolCallReminderBody(warning.toolName, warning.observedCount),
        ),
      ]);
    }
    const warningEvent = runtime.createEvent(
      SessionEventType.ModelAnomalyWarning,
      {
        category: "repeated_tool_call",
        severity: "warning",
        observedCount: warning.observedCount,
        threshold: warning.threshold,
        toolCallId: warning.toolCallId,
        toolName: warning.toolName,
        warningInjected: warning.warningInjected,
      },
      options.modelTraceContext,
    );
    await runtime.appendEvent(warningEvent, options.modelTraceContext);
    state.events.push(warningEvent);
  }
}
