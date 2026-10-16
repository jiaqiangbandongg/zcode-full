import type { Message, TimelineMessage } from "./app-model.js";
import type React from "react";
import { asRecord, numberField, stringField } from "./state.js";

const LOCAL_COMPACT_OPERATION_PREFIX = "local-compact";

let localCompactSequence = 0;

export function compactCommandFromText(text: string): string | undefined {
  const trimmed = text.trim();
  const match = /^\/(?:compact|compress)(?:\s+([\s\S]*))?$/iu.exec(trimmed);
  if (!match) return undefined;
  const instructions = match[1]?.trim();
  return instructions ? `/compact ${instructions}` : "/compact";
}

export function isCompactSlashCommand(text: string): boolean {
  return compactCommandFromText(text) !== undefined;
}

export function createLocalCompactTimelineMessage(input: {
  command?: string;
  reason?: string;
  status: TimelineMessage["status"];
}): Message {
  localCompactSequence += 1;
  const operationId = `${LOCAL_COMPACT_OPERATION_PREFIX}-${localCompactSequence}`;
  return compactTimelineMessage({
    command: input.command,
    operationId,
    reason: input.reason,
    status: input.status,
    trigger: "manual",
    type: "context_compaction",
  });
}

export function compactTimelineMessageFromPayload(
  payload: Record<string, unknown>,
): Message | null {
  const operationId = stringField(payload, "operationId");
  const status = timelineStatusValue(payload.status ?? payload.timelineStatus);
  if (!operationId || !status) {
    return null;
  }
  return compactTimelineMessage({
    attempt: numberField(payload, "attempt"),
    maxAttempts: numberField(payload, "maxAttempts"),
    messageId: stringField(payload, "messageId"),
    operationId,
    reason: stringField(payload, "reason"),
    status,
    trigger: stringField(payload, "trigger"),
    type: "context_compaction",
  });
}

export function upsertCompactTimelineMessage(current: Message[], nextMessage: Message): Message[] {
  const nextTimeline = nextMessage.timeline;
  if (!nextTimeline?.operationId) {
    return current;
  }
  const existingIndex = current.findIndex((message) => {
    const timeline = message.timeline;
    if (!timeline || timeline.type !== "context_compaction") {
      return false;
    }
    return (
      (nextTimeline.messageId && timeline.messageId === nextTimeline.messageId) ||
      timeline.operationId === nextTimeline.operationId ||
      (timeline.operationId.startsWith(LOCAL_COMPACT_OPERATION_PREFIX) &&
        isRunningCompactTimelineStatus(timeline.status) &&
        !nextTimeline.operationId.startsWith(LOCAL_COMPACT_OPERATION_PREFIX))
    );
  });
  if (existingIndex < 0) {
    return [...current, nextMessage];
  }

  return current.map((message, index) => {
    if (index !== existingIndex || !message.timeline) {
      return message;
    }
    return {
      ...message,
      content: nextMessage.content || message.content,
      id: nextMessage.id ?? message.id,
      timeline: {
        ...message.timeline,
        ...nextTimeline,
        command: nextTimeline.command ?? message.timeline.command,
      },
    };
  });
}

export function latestRetryableCompactCommand(messages: readonly Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const timeline = messages[index]?.timeline;
    if (
      timeline?.type === "context_compaction" &&
      (timeline.status === "failed" || timeline.status === "interrupted")
    ) {
      return timeline.command ?? "/compact";
    }
  }
  return undefined;
}

export function failLatestStartedCompactTimeline(current: Message[], reason: string): Message[] {
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const message = current[index];
    const timeline = message?.timeline;
    if (
      timeline?.type === "context_compaction" &&
      isRunningCompactTimelineStatus(timeline.status)
    ) {
      return current.map((item, itemIndex) =>
        itemIndex === index && item.timeline
          ? {
              ...item,
              timeline: {
                ...item.timeline,
                reason,
                status: "failed",
              },
            }
          : item,
      );
    }
  }
  return upsertCompactTimelineMessage(
    current,
    createLocalCompactTimelineMessage({ reason, status: "failed" }),
  );
}

function compactTimelineMessage(timeline: TimelineMessage): Message {
  return {
    content: "",
    id: timeline.messageId ?? `compact-${timeline.operationId}`,
    role: "timeline",
    timeline,
  };
}

function timelineStatusValue(value: unknown): TimelineMessage["status"] | undefined {
  return value === "started" ||
    value === "retrying" ||
    value === "skipped" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted"
    ? value
    : undefined;
}

function isRunningCompactTimelineStatus(status: TimelineMessage["status"]): boolean {
  return status === "started" || status === "retrying";
}

export function compactErrorMessage(errorPayload: unknown): string {
  const payload = asRecord(errorPayload);
  const nestedError = asRecord(payload.error);
  return (
    stringField(nestedError, "message") ??
    stringField(payload, "message") ??
    "Context compression failed."
  );
}

export function applyCompactTimelineEvent(
  payload: Record<string, unknown>,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): void {
  const message = compactTimelineMessageFromPayload(payload);
  if (!message) return;
  setMessages((current) => upsertCompactTimelineMessage(current, message));
}

export function applyCompactTurnErrorEvent(
  payload: Record<string, unknown>,
  setLastError: (message: string | undefined) => void,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): void {
  const message = compactErrorMessage(payload);
  setLastError(message);
  setMessages((current) => failLatestStartedCompactTimeline(current, message));
}
