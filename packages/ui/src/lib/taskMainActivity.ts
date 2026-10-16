import type { ZCodeStreamEvent, ZCodeTaskRuntimeStatus } from "@zcode/shared";
import type { TaskChatMessage } from "@/lib/taskChatMessageTypes.js";
import { hasRunningZCodeTimeline } from "@/lib/zcodeTimelineRuntime.js";

type TaskStreamMirrorBatchEvent = Extract<ZCodeStreamEvent, { type: "task_stream_mirror_batch" }>;
type TaskStreamMirrorOp = TaskStreamMirrorBatchEvent["ops"][number];

export function shouldMarkMainActiveFromStreamMirrorOps(
  ops: readonly TaskStreamMirrorOp[],
): boolean {
  if (ops.length === 0) {
    return true;
  }
  return ops.some((op) => {
    if (op.kind === "user_message") {
      return true;
    }
    return shouldMarkMainActiveFromStreamEvent(op.event);
  });
}

export function shouldMarkMainActiveFromStreamEvent(event: ZCodeStreamEvent): boolean {
  switch (event.type) {
    case "task_run_started":
    case "goal_iteration_started":
      return true;
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return event.content.length > 0 && isMainAgentStreamEvent(event);
    case "tool_call":
    case "tool_call_update":
      return isMainAgentStreamEvent(event);
    default:
      return false;
  }
}

export function hasForegroundStreamingAssistantMessage(
  messages: readonly TaskChatMessage[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.streaming === true &&
      !isTaskChatTimelineMessage(message),
  );
}

function isTaskChatTimelineMessage(message: TaskChatMessage): boolean {
  if (!message.syntheticTimeline && !message.uiTimeline) return false;
  return !(
    message.content.trim() ||
    message.thought?.trim() ||
    (message.toolCalls && message.toolCalls.length > 0)
  );
}

function isTaskRuntimeBusy(taskStatus: ZCodeTaskRuntimeStatus): boolean {
  return taskStatus === "creating" || taskStatus === "restoring" || taskStatus === "streaming";
}

export function hasForegroundActivityFromMessages(messages: readonly TaskChatMessage[]): boolean {
  return hasForegroundStreamingAssistantMessage(messages) || hasRunningZCodeTimeline(messages);
}

export function isMainActivityRuntimeBusy(params: {
  currentStatus?: "idle" | "submitting" | "streaming" | "error";
  runtimeState?: {
    activeInputId?: unknown;
    status: ZCodeTaskRuntimeStatus;
  } | null;
  isMainActive: boolean;
  hasForegroundActivity?: boolean;
}): boolean {
  const runtimeStatus = params.runtimeState?.status;
  const setupBusy = runtimeStatus === "creating" || runtimeStatus === "restoring";
  if (setupBusy) {
    return true;
  }
  if (params.currentStatus === "submitting") {
    return true;
  }
  if (params.hasForegroundActivity === true) {
    return true;
  }
  return (
    params.isMainActive &&
    (Boolean(params.runtimeState?.activeInputId) ||
      (runtimeStatus != null && isTaskRuntimeBusy(runtimeStatus)))
  );
}

function isMainAgentStreamEvent(
  event: Extract<
    ZCodeStreamEvent,
    { type: "agent_message_chunk" | "agent_thought_chunk" | "tool_call" | "tool_call_update" }
  >,
): boolean {
  if (event.parentToolUseId != null) {
    return false;
  }
  return !("raw" in event && isSubagentToolRaw(event.raw));
}

function isSubagentToolRaw(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "source" in raw &&
    (raw as { source?: unknown }).source === "subagent"
  );
}
