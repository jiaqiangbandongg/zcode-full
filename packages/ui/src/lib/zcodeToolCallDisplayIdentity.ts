import type { TaskChatToolCall } from "@/lib/taskChatMessageTypes.js";

interface ToolCallDisplayIdentityFields {
  kind?: string | null;
  title?: string | null;
  toolName?: string | null;
}

interface MergeToolCallDisplayIdentityOptions {
  fallbackKind?: string | null;
}

interface MergedToolCallDisplayIdentityFields {
  kind?: string;
  title?: string;
  toolName?: string;
}

function knownToolIdentity(value: string | null | undefined): string | undefined {
  if (!value || value.toLowerCase() === "unknown") {
    return undefined;
  }
  return value;
}

function mergeToolIdentity(
  preferred: string | null | undefined,
  fallback: string | null | undefined,
): string | undefined {
  return knownToolIdentity(preferred) ?? knownToolIdentity(fallback);
}

export function mergeToolCallDisplayIdentityFields(
  preferred: ToolCallDisplayIdentityFields,
  fallback?: ToolCallDisplayIdentityFields,
  options: MergeToolCallDisplayIdentityOptions = {},
): MergedToolCallDisplayIdentityFields {
  const toolName = mergeToolIdentity(preferred.toolName, fallback?.toolName);
  const kind =
    mergeToolIdentity(preferred.kind, fallback?.kind) ??
    toolName ??
    options.fallbackKind ??
    undefined;
  const title = mergeToolIdentity(preferred.title, fallback?.title) ?? toolName;
  return {
    ...(toolName ? { toolName } : {}),
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
  };
}

export function normalizeToolCallDisplayIdentity(toolCall: TaskChatToolCall): TaskChatToolCall {
  const identity = mergeToolIdentity(toolCall.toolName, toolCall.kind);
  if (!identity) {
    return toolCall;
  }
  const toolName = knownToolIdentity(toolCall.toolName);
  const kind = knownToolIdentity(toolCall.kind) ?? identity;
  const title = knownToolIdentity(toolCall.title) ?? identity;
  if (toolName === toolCall.toolName && kind === toolCall.kind && title === toolCall.title) {
    return toolCall;
  }
  return {
    ...toolCall,
    toolName,
    kind,
    title,
  };
}

export function normalizeToolCallDisplayIdentities(
  toolCalls: readonly TaskChatToolCall[] | undefined,
): TaskChatToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) {
    return toolCalls as TaskChatToolCall[] | undefined;
  }
  let changed = false;
  const normalized = toolCalls.map((toolCall) => {
    const nextToolCall = normalizeToolCallDisplayIdentity(toolCall);
    if (nextToolCall !== toolCall) {
      changed = true;
    }
    return nextToolCall;
  });
  return changed ? normalized : (toolCalls as TaskChatToolCall[]);
}
