import type { CompactBoundaryPayload, MessagePart, MessageWithParts } from "@zcode/contracts";
import { invalidateRuntimeTokenUsage } from "./message-history.js";

export function compactActiveSessionMessages(
  messages: MessageWithParts[],
  boundaryIndex: number,
  includePreservedSegment: boolean,
): MessageWithParts[] {
  const activeMessages = messages.slice(boundaryIndex);
  if (!includePreservedSegment) return activeMessages;

  const boundary = compactBoundaryFromMessage(messages[boundaryIndex]!);
  const preservedMessages = compactPreservedSegmentMessages(messages, boundaryIndex);
  if (!boundary?.preservedSegment || preservedMessages.length === 0) {
    return activeMessages;
  }

  const anchorIndex = activeMessages.findIndex(
    (message) => message.info.id === boundary.preservedSegment?.anchorMessageId,
  );
  const insertIndex = anchorIndex >= 0 ? anchorIndex + 1 : 1;
  return [
    ...activeMessages.slice(0, insertIndex),
    ...preservedMessages,
    ...activeMessages.slice(insertIndex),
  ];
}

export function compactPreservedSegmentMessages(
  messages: MessageWithParts[],
  boundaryIndex: number,
): MessageWithParts[] {
  const boundary = compactBoundaryFromMessage(messages[boundaryIndex]!);
  const segment = boundary?.preservedSegment;
  if (!segment) return [];

  const headIndex = messages.findIndex((message) => message.info.id === segment.headMessageId);
  const tailIndex = messages.findIndex((message) => message.info.id === segment.tailMessageId);
  if (headIndex < 0 || tailIndex < headIndex || tailIndex >= boundaryIndex) {
    return [];
  }

  return messages
    .slice(headIndex, tailIndex + 1)
    .filter(isCompactPreservableSessionMessage)
    .map(cloneCompactPreservedSessionMessage);
}

function cloneCompactPreservedSessionMessage(message: MessageWithParts): MessageWithParts {
  if (message.info.role !== "assistant") return message;
  return {
    ...message,
    info: {
      ...message.info,
      tokens: invalidateRuntimeTokenUsage(message.info.tokens),
    },
  };
}

export function compactBoundaryFromMessage(
  message: MessageWithParts,
): CompactBoundaryPayload | undefined {
  for (const part of message.parts) {
    if (part.type === "compaction" && part.compactBoundary) {
      return part.compactBoundary;
    }
  }
  return undefined;
}

export function isCompactPreservableSessionMessage(message: MessageWithParts): boolean {
  // UI timeline 也使用 assistant role，但不属于模型轮，不能让保留组的起点错位。
  if (message.info.semantics?.providerVisibility === "hidden") return false;
  if (message.parts.some((part) => part.type === "compaction")) {
    return false;
  }
  // synthetic/model-only 只描述输入身份和 UI 可见性；已选中的回信、任务结果和
  // attachment 没有进入 summary，冷恢复不能据此再次丢弃它们。
  if (message.info.role === "assistant" && message.info.error) {
    return false;
  }
  return message.info.role === "user" || message.info.role === "assistant";
}

export function isActiveCompactionBoundaryPart(part: MessagePart): boolean {
  return part.type === "compaction" && (Boolean(part.compactBoundary) || !part.timelineStatus);
}
