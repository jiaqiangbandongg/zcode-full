import type { ModelUsage } from "@zcode/contracts";
import { formatTaskNotification } from "../runtime-task/notification.js";

export type LocalAgentTaskNotificationStatus =
  | "completed"
  | "failed"
  | "stopped";

export interface LocalAgentTaskNotificationInput {
  agentId: string;
  agentType: string;
  description: string;
  error?: string;
  outputFile: string;
  parentToolCallId: string;
  result?: string;
  status: LocalAgentTaskNotificationStatus;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  usage?: ModelUsage;
}

export function formatLocalAgentTaskNotification(
  input: LocalAgentTaskNotificationInput,
): string {
  return formatTaskNotification({
    agentId: input.agentId,
    description: input.description,
    error: input.error,
    outputFile: input.outputFile,
    result: input.result,
    status: input.status,
    subagentType: input.agentType,
    summary: formatLocalAgentNotificationSummary(input),
    taskId: input.agentId,
    taskType: "local_agent",
    toolUseId: input.parentToolCallId,
    usage: {
      durationMs: input.totalDurationMs,
      modelUsage: input.usage,
      toolUseCount: input.totalToolUseCount,
      totalTokens: input.totalTokens,
    },
  });
}

function formatLocalAgentNotificationSummary(
  input: Pick<
    LocalAgentTaskNotificationInput,
    "agentType" | "description" | "error" | "status"
  >,
): string {
  const summary = `Agent ${input.agentType} task "${input.description}" ${input.status}.`;
  const error =
    input.status === "failed" && input.error?.trim() ? input.error : undefined;
  // 修复原因：失败 summary 是 Agent 卡“子智能体输出”的来源，必须保留原前缀并
  // 直接追加与 <error> 相同的失败原因；completed/stopped 文案保持不变。
  return error ? `${summary} ${error}` : summary;
}
