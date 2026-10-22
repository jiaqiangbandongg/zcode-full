import type { SSHConnectionConfig } from "./ssh-remote-p0.js";

interface ToolExecutionQuery {
  toolCallId?: string;
  sessionId?: string;
  toolName: string;
}

export interface RemoteToolExecutionEvent {
  event: "tool.call.started" | "tool.call.completed";
  toolCallId: string;
  toolName: string;
  sessionId?: string;
}

/** 保留每个真实事件，包括同 ID 的重复执行；不以文件内容或去重后的 ID 代替执行次数。 */
export function parseRemoteToolExecutionEvents(
  text: string,
  query: ToolExecutionQuery,
): RemoteToolExecutionEvent[] {
  if (!query.toolCallId && !query.sessionId) throw new Error("工具执行取证必须限定任务或调用身份");
  const events: RemoteToolExecutionEvent[] = [];
  for (const line of text.split("\n").filter((line) => line.trim())) {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("远端工具日志不是合法对象");
    }
    const context =
      record.context && typeof record.context === "object"
        ? (record.context as Record<string, unknown>)
        : {};
    const toolCallId = record.toolCallId ?? context.toolCallId;
    const sessionId = record.sessionId ?? context.sessionId;
    if (
      (record.event === "tool.call.started" || record.event === "tool.call.completed") &&
      typeof toolCallId === "string" &&
      (!query.toolCallId || toolCallId === query.toolCallId) &&
      (!query.sessionId || sessionId === query.sessionId) &&
      (record.toolName ?? context.toolName) === query.toolName
    ) {
      events.push({
        event: record.event,
        toolCallId,
        toolName: query.toolName,
        ...(typeof sessionId === "string" ? { sessionId } : {}),
      });
    }
  }
  return events;
}

export async function readRemoteToolExecutionEvents(
  config: SSHConnectionConfig,
  query: ToolExecutionQuery,
): Promise<RemoteToolExecutionEvent[]> {
  const { runSSHCommand } = await import("./ssh-remote-p0.js");
  const result = await runSSHCommand(
    config,
    `grep -h -E '"event"[[:space:]]*:[[:space:]]*"tool[.]call[.](started|completed)"' "$HOME/.zcode/cli/log/"*.jsonl`,
  );
  // grep 1 表示没有执行事件；日志不可读等真实错误不能伪装为零次执行。
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`无法读取远端工具执行日志（exit=${result.code}）`);
  }
  return parseRemoteToolExecutionEvents(result.stdout, query);
}
