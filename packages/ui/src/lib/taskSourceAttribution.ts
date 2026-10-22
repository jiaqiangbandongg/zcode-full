import { parseRemoteWorkspaceIdentity } from "@zcode/shared";

export interface TaskSourceAttributionInput {
  workspacePath: string;
  workspaceIdentity?: string;
  sourceServerId?: string;
  serverDisplayName?: string;
}

function resolveTaskSourceServerId(task: TaskSourceAttributionInput): string | null {
  const explicitSourceServerId = task.sourceServerId?.trim();
  if (explicitSourceServerId) return explicitSourceServerId;
  const parsed = task.workspaceIdentity
    ? parseRemoteWorkspaceIdentity(task.workspaceIdentity)
    : null;
  return parsed?.kind === "server" ? parsed.sourceServerId?.trim() || null : null;
}

export function resolveTaskSourceLabel(task: TaskSourceAttributionInput): string | null {
  const displayName = task.serverDisplayName?.trim();
  if (displayName) return displayName;
  // Source id 是稳定内部身份，不是用户可读名称；没有 displayName 时不要把 UUID 片段泄漏到任务行。
  return null;
}

export function projectTaskSourceDisplayName<T extends TaskSourceAttributionInput>(
  task: T,
  displayNames: ReadonlyMap<string, string>,
): T & { serverDisplayName?: string } {
  if (task.serverDisplayName?.trim()) return task;
  const sourceServerId = resolveTaskSourceServerId(task);
  const serverDisplayName = sourceServerId ? displayNames.get(sourceServerId)?.trim() : undefined;
  return serverDisplayName ? { ...task, serverDisplayName } : task;
}
