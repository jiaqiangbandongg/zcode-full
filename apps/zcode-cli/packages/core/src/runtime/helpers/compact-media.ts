import { traceContextToLogContext } from "../deps.js";
import type {
  Logger,
  ModelInputMessage,
  ModelMessageContent,
  ModelMessageContentBlock,
  TraceContext,
} from "../deps.js";
import {
  officialCuaImageRefIndexesForUnavailableMedia,
  officialCuaRasterUnavailableBlock,
} from "./official-cua-media.js";

export interface CompactMediaPlaceholderProjection {
  messages: ModelInputMessage[];
  replacedMediaCount: number;
}

export function projectCompactMediaForRetry(
  messages: readonly ModelInputMessage[],
): CompactMediaPlaceholderProjection {
  let replacedMediaCount = 0;
  const projectedMessages = messages.map((message) => {
    const projectedContent = projectCompactContent(message.content);
    replacedMediaCount += projectedContent.replacedMediaCount;
    if (projectedContent.replacedMediaCount === 0) return message;

    return {
      ...message,
      cacheControl: message.cacheControl ? { ...message.cacheControl } : undefined,
      content: projectedContent.content,
      toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
    };
  });

  return {
    messages: projectedMessages,
    replacedMediaCount,
  };
}

export function logCompactMediaRetryProjection(
  logger: Logger | undefined,
  traceContext: TraceContext,
  projection: CompactMediaPlaceholderProjection,
): void {
  if (projection.replacedMediaCount === 0) return;
  logger?.debug("Compact request media replaced with placeholders", {
    ...traceContextToLogContext(traceContext),
    event: "compact.request.media_placeholder_projection",
    module: "core.runtime",
    replacedMediaCount: projection.replacedMediaCount,
    status: "completed",
  });
}

function projectCompactContent(content: ModelMessageContent): {
  content: ModelMessageContent;
  replacedMediaCount: number;
} {
  if (!Array.isArray(content)) {
    return { content, replacedMediaCount: 0 };
  }

  const replacedIndexes = new Set<number>();
  const projectedBlocks = content.map((block, blockIndex) => {
    const projectedBlock = projectCompactBlock(block);
    if (projectedBlock.replaced) replacedIndexes.add(blockIndex);
    return projectedBlock.block;
  });

  const imageRefIndexes = officialCuaImageRefIndexesForUnavailableMedia(content, replacedIndexes);
  for (const imageRefIndex of imageRefIndexes) {
    projectedBlocks[imageRefIndex - 1] = officialCuaRasterUnavailableBlock();
    projectedBlocks[imageRefIndex] = { type: "text", text: "" };
  }

  return {
    content: replacedIndexes.size > 0 ? projectedBlocks : content,
    replacedMediaCount: replacedIndexes.size,
  };
}

function projectCompactBlock(block: ModelMessageContentBlock): {
  block: ModelMessageContentBlock;
  replaced: boolean;
} {
  if (block.type === "image") {
    return { block: compactPlaceholderBlock("[image]"), replaced: true };
  }
  // video 与 image/document 同语义：retry 媒体瘦身漏掉 video 会让大体积 base64
  // 原样穿过 retry 请求，违背占位投影的目的。
  if (block.type === "video") {
    return { block: compactPlaceholderBlock("[video]"), replaced: true };
  }
  if (block.type === "file" && isCompactDocumentMedia(block)) {
    return { block: compactPlaceholderBlock("[document]"), replaced: true };
  }
  return { block: cloneCompactBlock(block), replaced: false };
}

function isCompactDocumentMedia(
  block: Extract<ModelMessageContentBlock, { type: "file" }>,
): boolean {
  if (block.text !== undefined && block.text.length > 0) return false;
  return Boolean(block.dataUrl || block.uri);
}

function compactPlaceholderBlock(
  text: "[document]" | "[image]" | "[video]",
): ModelMessageContentBlock {
  return { type: "text", text };
}

function cloneCompactBlock(block: ModelMessageContentBlock): ModelMessageContentBlock {
  if ("source" in block && block.source) {
    return { ...block, source: { ...block.source } };
  }
  return { ...block };
}
