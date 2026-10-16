// ============================================================
// Subagent Tool Event Mirror
// ============================================================

import {
  SessionEventType,
  createSessionEvent,
  type SessionEvent,
  type ToolCallId,
} from "@zcode/contracts";
import {
  buildSubagentInteractionOrigin,
  type SubagentInteractionOriginContext,
} from "./interaction-origin.js";

const SUBAGENT_TOOL_CALL_ID_PREFIX = "tool_subagent";
const SUBAGENT_EVENT_SOURCE = "subagent";

const MIRRORED_TOOL_EVENT_TYPES = new Set<SessionEventType>([
  SessionEventType.ToolCallScheduled,
  SessionEventType.ToolCallStarted,
  SessionEventType.ToolCallProgress,
  SessionEventType.ToolCallResult,
  SessionEventType.ToolCallError,
]);

const MIRRORED_INTERACTION_EVENT_TYPES = new Set<SessionEventType>([
  SessionEventType.PermissionRequested,
  SessionEventType.PermissionResolved,
  SessionEventType.PermissionDenied,
]);

interface SubagentToolEventMirrorContext extends SubagentInteractionOriginContext {
  background: boolean;
  toolNameByChildToolCallId?: Map<string, string>;
}

export function mirrorSubagentToolEvent(
  event: SessionEvent,
  context: SubagentToolEventMirrorContext,
): SessionEvent | undefined {
  if (
    !MIRRORED_TOOL_EVENT_TYPES.has(event.type) &&
    !MIRRORED_INTERACTION_EVENT_TYPES.has(event.type)
  ) {
    return undefined;
  }

  const payload = asRecord(event.payload);
  const childToolCallId = stringField(payload, "toolCallId");
  if (!childToolCallId) return undefined;

  const toolCallId = mirroredToolCallId(context.agentId, childToolCallId);
  const toolName =
    stringField(payload, "toolName") ?? context.toolNameByChildToolCallId?.get(childToolCallId);
  if (toolName) {
    context.toolNameByChildToolCallId?.set(childToolCallId, toolName);
  }

  if (MIRRORED_INTERACTION_EVENT_TYPES.has(event.type)) {
    return mirrorInteraction(event, payload, toolCallId, toolName, context);
  }

  const mirroredPayload = {
    ...payload,
    toolCallId,
    ...(toolName ? { toolName } : {}),
    ...mirrorScheduleFields(payload, context.agentId),
    agentId: context.agentId,
    agentType: context.agentType,
    ...(context.background ? { background: true } : {}),
    childSessionId: context.childSessionId,
    childToolCallId,
    description: context.description,
    parentToolCallId: context.parentToolCallId,
    source: SUBAGENT_EVENT_SOURCE,
  };

  return createSessionEvent(event.type, context.parentSessionId, mirroredPayload, {
    traceId: event.traceId,
    turnId: context.parentTurnId,
  });
}

/**
 * 只镜像交互事件（PermissionRequested / Resolved / Denied），不镜像工具活动。
 * 供 class 外构造的子 runtime（dwf actor）使用：它们的工具活动有自己的呈现面（run 卡片 /
 * 子会话 transcript），父 timeline 不该出现；但确认窗只从父会话的实时投影生成，交互必须过来
 * （docs/dynamic-workflow/launch.md「Permissions inside a run」）。
 */
export function mirrorSubagentInteractionEvent(
  event: SessionEvent,
  context: SubagentInteractionOriginContext,
): SessionEvent | undefined {
  if (!MIRRORED_INTERACTION_EVENT_TYPES.has(event.type)) return undefined;
  const payload = asRecord(event.payload);
  const childToolCallId = stringField(payload, "toolCallId");
  if (!childToolCallId) return undefined;
  return mirrorInteraction(
    event,
    payload,
    mirroredToolCallId(context.agentId, childToolCallId),
    stringField(payload, "toolName"),
    context,
  );
}

function mirrorInteraction(
  event: SessionEvent,
  payload: Record<string, unknown>,
  toolCallId: ToolCallId,
  toolName: string | undefined,
  context: SubagentInteractionOriginContext & { background?: boolean },
): SessionEvent {
  // 修复原因：V4 只从父 task 的实时投影生成阻塞交互；仅转发 broker request 会让
  // 子 agent 的 permission / AskUserQuestion 停留在子 session，父界面无法响应。
  const mirroredPayload = {
    ...payload,
    toolCallId,
    ...(toolName ? { toolName } : {}),
    childSessionId: context.childSessionId,
    ...(context.background ? { background: true } : {}),
    ...(event.type === SessionEventType.PermissionRequested
      ? { origin: buildSubagentInteractionOrigin(context, event.turnId) }
      : {}),
  };
  return createSessionEvent(event.type, context.parentSessionId, mirroredPayload, {
    traceId: event.traceId,
    turnId: context.parentTurnId,
  });
}

function mirrorScheduleFields(
  payload: Record<string, unknown>,
  agentId: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (Array.isArray(payload.dependencies)) {
    fields.dependencies = payload.dependencies
      .filter((value): value is string => typeof value === "string")
      .map((id) => mirroredToolCallId(agentId, id));
  }

  const schedule = asRecord(payload.schedule);
  if (Object.keys(schedule).length > 0) {
    fields.schedule = {
      ...schedule,
      executionOrder: stringArrayField(schedule, "executionOrder").map((id) =>
        mirroredToolCallId(agentId, id),
      ),
      parallelGroups: arrayField(schedule, "parallelGroups").map((group) =>
        Array.isArray(group)
          ? group
              .filter((id): id is string => typeof id === "string")
              .map((id) => mirroredToolCallId(agentId, id))
          : group,
      ),
    };
  }

  return fields;
}

function mirroredToolCallId(agentId: string, childToolCallId: string): ToolCallId {
  return `${SUBAGENT_TOOL_CALL_ID_PREFIX}_${agentId}_${childToolCallId}` as ToolCallId;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  return arrayField(record, key).filter((value): value is string => typeof value === "string");
}
