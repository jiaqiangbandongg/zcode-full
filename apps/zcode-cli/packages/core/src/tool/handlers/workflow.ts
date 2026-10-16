// ============================================================
// Workflow Tool Handler
// ============================================================

import {
  CoreErrorType,
  WorkflowInputJsonSchema,
  WorkflowInputSchema,
  WorkflowOutputJsonSchema,
  WorkflowOutputSchema,
  createCoreError,
  type TraceContext,
  type WorkflowInput,
} from "@zcode/contracts";
import type { ModelMessageContent } from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { WORKFLOW_TOOL_DESCRIPTION } from "./workflow-description.js";
import { assertNotOffPeakTurn } from "./off-peak.js";

const WORKFLOW_TOOL_NAME = "Workflow";
/**
 * D52：Workflow 的脚本子会话由 script-workflow-child-runtime 按父会话常驻选择建模型，
 * 不携带闲时轮的 modelExecution，同样会落到用户 Coding Plan，闲时轮内一并拒绝。
 */
const OFF_PEAK_WORKFLOW_HINT = "Run the child work with foreground Agent calls instead.";

const WORKFLOW_LAUNCH_TIMEOUT_MS = 30_000;
const WORKFLOW_MODEL_BYTES = 24_000;

const workflowHandler: ToolHandler = async (input, context) => {
  const parsed = WorkflowInputSchema.parse(input) as WorkflowInput;
  assertNotOffPeakTurn(context, WORKFLOW_TOOL_NAME, {
    hint: OFF_PEAK_WORKFLOW_HINT,
    recoverable: true,
  });
  if (!context.workflowPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "WorkflowPort is not configured for Workflow tool",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: WORKFLOW_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  return context.workflowPort.start(
    {
      ...parsed,
      parentToolCallId: context.toolCallId,
      sessionId: context.sessionId,
      trace: {
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: context.parentSpanId,
        sessionId: context.sessionId,
        turnId: context.turnId,
      } as TraceContext,
      turnId: context.turnId,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
    },
    { signal: context.abortSignal },
  );
};

export const workflowToolEntry: ToolEntry = {
  capability:
    "Start or resume a deterministic script workflow that orchestrates multiple child agent sessions",
  metadata: {
    name: "Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    readOnly: false,
    destructive: true,
    concurrentSafe: false,
    timeoutMs: WORKFLOW_LAUNCH_TIMEOUT_MS,
    maxOutputBytes: WORKFLOW_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "high",
    needsApproval: true,
  },
  handler: workflowHandler,
  inputSchema: WorkflowInputJsonSchema,
  outputSchema: WorkflowOutputJsonSchema,
  runtimeInputSchema: WorkflowInputSchema,
  runtimeOutputSchema: WorkflowOutputSchema,
  formatModelContent: formatWorkflowModelContent,
  permission: {
    permission: "workflow",
    reason:
      "Workflow launches background child agents that may perform workspace-mutating work in yolo mode",
    riskLevel: "high",
    sideEffectScope: "workspace",
    needsApproval: true,
    patternSources: ["toolName", "input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: WORKFLOW_MODEL_BYTES,
    maxModelBytes: WORKFLOW_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: WORKFLOW_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: WORKFLOW_LAUNCH_TIMEOUT_MS,
    maxMs: WORKFLOW_LAUNCH_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage: "Workflow launch was cancelled before a run id was returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatWorkflowModelContent(output: unknown): ModelMessageContent {
  const parsed = WorkflowOutputSchema.safeParse(output);
  if (!parsed.success) return "Workflow launch returned an invalid result.";

  const lines = [
    `Workflow ${parsed.data.status}: ${parsed.data.runId}`,
    parsed.data.scriptPath ? `scriptPath: ${parsed.data.scriptPath}` : undefined,
    parsed.data.response,
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}
