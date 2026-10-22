import {
  createUnsupportedModelInputMediaText,
  getUnsupportedModelInputMediaKind,
  isProviderVisibleModelInputMediaBlock,
  isProviderVisiblePdfModelInputBlock,
  isProviderVisibleVideoModelInputBlock,
  traceContextToLogContext,
} from "../deps.js";
import type {
  Logger,
  ModelInputFormat,
  ModelInputMessage,
  ModelMessageContentBlock,
  TraceContext,
} from "../deps.js";
import {
  officialCuaImageRefIndexesForUnavailableMedia,
  officialCuaRasterUnavailableBlock,
} from "./official-cua-media.js";

export interface MediaCapabilityProjection {
  messages: ModelInputMessage[];
  omittedImageCount: number;
  omittedMediaCount: number;
  omittedPdfCount: number;
  omittedVideoCount: number;
  retainedMediaCount: number;
}

export function projectMessagesForInputFormat(
  messages: ModelInputMessage[],
  inputFormat: ModelInputFormat,
): MediaCapabilityProjection {
  if (inputFormat.supportsImage && inputFormat.supportsPdf && inputFormat.supportsVideo) {
    return {
      messages,
      omittedImageCount: 0,
      omittedMediaCount: 0,
      omittedPdfCount: 0,
      omittedVideoCount: 0,
      retainedMediaCount: countProviderVisibleMedia(messages),
    };
  }

  let omittedOtherMediaCount = 0;
  let omittedImageCount = 0;
  let omittedPdfCount = 0;
  let omittedVideoCount = 0;
  let retainedMediaCount = 0;
  let changed = false;

  const projectedMessages = messages.map((message) => {
    if (!Array.isArray(message.content)) {
      return message;
    }

    let messageChanged = false;
    const unavailableMediaIndexes = new Set<number>();
    message.content.forEach((block, index) => {
      if (unsupportedMediaReplacement(block, inputFormat)) unavailableMediaIndexes.add(index);
    });
    const imageRefIndexes = officialCuaImageRefIndexesForUnavailableMedia(
      message.content,
      unavailableMediaIndexes,
    );
    const content = message.content.map((block, index) => {
      if (imageRefIndexes.has(index)) {
        messageChanged = true;
        changed = true;
        return { type: "text" as const, text: "" };
      }
      const replacement = unsupportedMediaReplacement(block, inputFormat);
      if (!replacement) {
        if (isProviderVisibleModelInputMediaBlock(block)) retainedMediaCount++;
        return cloneContentBlock(block);
      }

      messageChanged = true;
      changed = true;
      if (block.type === "image") omittedImageCount++;
      else if (isProviderVisiblePdfModelInputBlock(block)) omittedPdfCount++;
      else if (isProviderVisibleVideoModelInputBlock(block)) omittedVideoCount++;
      else omittedOtherMediaCount++;
      return imageRefIndexes.has(index + 1) ? officialCuaRasterUnavailableBlock() : replacement;
    });

    if (!messageChanged) {
      return message;
    }

    return {
      ...message,
      cacheControl: message.cacheControl ? { ...message.cacheControl } : undefined,
      content,
      toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
    };
  });

  const omittedMediaCount =
    omittedImageCount + omittedPdfCount + omittedVideoCount + omittedOtherMediaCount;
  return {
    messages: changed ? projectedMessages : messages,
    omittedImageCount,
    omittedMediaCount,
    omittedPdfCount,
    omittedVideoCount,
    retainedMediaCount,
  };
}

export function logMediaCapabilityProjection(
  logger: Logger | undefined,
  traceContext: TraceContext,
  projection: MediaCapabilityProjection,
  options: { event: string; message: string; model: string },
): void {
  if (projection.omittedMediaCount === 0) return;
  logger?.debug(options.message, {
    ...traceContextToLogContext(traceContext),
    event: options.event,
    model: options.model,
    module: "core.runtime",
    omittedImageCount: projection.omittedImageCount,
    omittedMediaCount: projection.omittedMediaCount,
    omittedPdfCount: projection.omittedPdfCount,
    omittedVideoCount: projection.omittedVideoCount,
    retainedMediaCount: projection.retainedMediaCount,
    status: "completed",
  });
}

function unsupportedMediaReplacement(
  block: ModelMessageContentBlock,
  inputFormat: ModelInputFormat,
): ModelMessageContentBlock | undefined {
  const unsupportedKind = getUnsupportedModelInputMediaKind(block, inputFormat);
  return unsupportedKind
    ? { type: "text", text: createUnsupportedModelInputMediaText(block, unsupportedKind) }
    : undefined;
}

function countProviderVisibleMedia(messages: ModelInputMessage[]): number {
  return messages.reduce((count, message) => {
    if (!Array.isArray(message.content)) return count;
    return count + message.content.filter(isProviderVisibleModelInputMediaBlock).length;
  }, 0);
}

function cloneContentBlock(block: ModelMessageContentBlock): ModelMessageContentBlock {
  switch (block.type) {
    case "image":
    case "video":
    case "file":
      return { ...block, source: block.source ? { ...block.source } : undefined };
    case "text":
    case "reasoning":
    case "tool_reference":
    case "resource_link":
      return { ...block };
  }
}
