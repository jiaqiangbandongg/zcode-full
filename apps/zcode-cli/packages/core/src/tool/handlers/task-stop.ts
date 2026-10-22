import {
  CoreErrorType,
  TASK_STOP_TOOL_NAME,
  TaskStopInputJsonSchema,
  TaskStopInputSchema,
  TaskStopOutputJsonSchema,
  TaskStopOutputSchema,
  createCoreError,
  type TaskStopInput,
  type TaskStopOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_TASK_STOP_MODEL_BYTES = 100_000;
const TASK_STOP_LOOKUP_FAILURE_GUIDANCE =
  "This lookup failure does not mean the task has completed or stopped; use the full task_id returned when the task started to stop it.";

// provider 请求直接使用 metadata.description，内部短说明会让模型看不到
// 参数、返回值和使用时机。capability 继续保留短说明。
const TASK_STOP_PROVIDER_DESCRIPTION = [
  "",
  "- Stops a running background task by its ID",
  "- Takes a task_id parameter identifying the task to stop",
  "- Returns a success or failure status",
  "- Use this tool when you need to terminate a long-running task",
  "",
].join("\n");

const taskStopHandler: ToolHandler = async (input, context) => {
  const parsed = TaskStopInputSchema.parse(input) as TaskStopInput;
  const taskId = parsed.task_id ?? parsed.shell_id;
  if (!taskId) {
    throw taskStopError("Missing required parameter: task_id", 1, {
      toolCallId: context.toolCallId,
    });
  }

  if (!context.backgroundTaskControlPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Background task control is not configured for TaskStop",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: TASK_STOP_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const result = await context.backgroundTaskControlPort.stopBackgroundTask(taskId, {
    // 模型自己停的：终态通知会说「stopped by you」，而不是把它写成用户的决定。
    initiator: "model",
    strict: true,
    traceContext: context.traceContext,
  });
  if (!result.ok) {
    if (result.reason === "background_task_not_running") {
      throw taskStopError(
        `Task ${taskId} is not running (status: ${result.status ?? "unknown"})`,
        3,
        {
          status: result.status,
          taskId,
          taskType: result.type,
          toolCallId: context.toolCallId,
        },
      );
    }
    if (result.reason === "background_task_cancel_not_supported") {
      throw taskStopError(`Task ${taskId} cannot be stopped`, 1, {
        reason: result.reason,
        status: result.status,
        taskId,
        taskType: result.type,
        toolCallId: context.toolCallId,
      });
    }
    // 单纯提示未找到任务容易被模型误读为已停止；明确查找失败不代表终态，并要求使用完整 ID。
    throw taskStopError(`Invalid task ID "${taskId}". ${TASK_STOP_LOOKUP_FAILURE_GUIDANCE}`, 1, {
      reason: result.reason,
      taskId,
      taskType: result.type,
      toolCallId: context.toolCallId,
    });
  }

  const taskType = result.type ?? "background_task";
  const output: TaskStopOutput = {
    message: `Successfully stopped task: ${result.taskId} (${result.command ?? taskType})`,
    task_id: result.taskId,
    task_type: taskType,
    ...(result.command ? { command: result.command } : {}),
  };
  return output;
};

export const taskStopToolEntry: ToolEntry = {
  aliases: ["KillShell", "KillBash"],
  capability: "Stop a running background task by ID",
  metadata: {
    shouldDefer: true,
    name: TASK_STOP_TOOL_NAME,
    searchHint: "kill a running background task",
    description: TASK_STOP_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10000,
    maxOutputBytes: MAX_TASK_STOP_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: taskStopHandler,
  formatModelContent: formatTaskStopModelContent,
  inputSchema: TaskStopInputJsonSchema,
  outputSchema: TaskStopOutputJsonSchema,
  runtimeInputSchema: TaskStopInputSchema,
  runtimeOutputSchema: TaskStopOutputSchema,
  permission: {
    permission: "backgroundTask.stop",
    reason: "TaskStop stops a running background task in the current runtime",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TASK_STOP_MODEL_BYTES,
    maxModelBytes: MAX_TASK_STOP_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_TASK_STOP_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 10000,
    maxMs: 10000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "TaskStop was cancelled before the stop request completed",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatTaskStopModelContent(output: unknown): string {
  return JSON.stringify(TaskStopOutputSchema.parse(output));
}

function taskStopError(message: string, code: 1 | 3, context: Record<string, unknown>): Error {
  return createCoreError(CoreErrorType.ToolExecutionFailed, message, {
    context: {
      ...context,
      code,
      toolName: TASK_STOP_TOOL_NAME,
    },
    recoverable: true,
  });
}
