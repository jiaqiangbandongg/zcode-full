import {
  CoreErrorType,
  MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE,
  createCoreError,
  modelMessageContentToText,
  traceContextToLogContext,
} from "../deps.js";
import type {
  Logger,
  ModelInputFormat,
  ModelInputMessage,
  ModelMessageContent,
  ModelMessageContentBlock,
  TraceContext,
} from "../deps.js";
import {
  officialCuaImageRefIndexesForUnavailableMedia,
  officialCuaRasterUnavailableBlock,
} from "./official-cua-media.js";
import { findLatestRealUserMessageIndex } from "./conversation.js";
import {
  projectMessagesForInputFormat,
  type MediaCapabilityProjection,
} from "./media-capability.js";

// 独立的视频预算无法约束请求总量；所有媒体统一按编码后的体积计入 40MiB，
// 为正文等非媒体内容预留空间。单文件原始字节限制由附件输入/Read 层负责。
export const DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES = 40 * 1024 * 1024;

interface MediaBlockRef {
  blockIndex: number;
  requestBytes: number;
  messageIndex: number;
  protected: boolean;
}

export interface MediaBudgetProjection {
  messages: ModelInputMessage[];
  omittedMediaCount: number;
  projectedMediaBytes: number;
  retainedMediaCount: number;
  totalMediaBytes: number;
}

export interface ModelMediaPolicyProjection {
  capabilityProjection: MediaCapabilityProjection;
  mediaBudgetProjection: MediaBudgetProjection;
  messages: ModelInputMessage[];
}

export function projectMessagesForModelMediaPolicy(
  messages: ModelInputMessage[],
  inputFormat: ModelInputFormat,
  options: { latestRealUserMessageIndex?: number } = {},
): ModelMediaPolicyProjection {
  // 直接调用 Model 的辅助链路曾只补 capability、漏掉聚合预算；两阶段必须
  // 在同一个请求策略边界串联，避免新增消费者继续手工拼装而遗漏其中一半。
  const capabilityProjection = projectMessagesForInputFormat(messages, inputFormat);
  const mediaBudgetProjection = projectMessagesForMediaBudget(capabilityProjection.messages, {
    latestRealUserMessageIndex: options.latestRealUserMessageIndex,
  });
  return {
    capabilityProjection,
    mediaBudgetProjection,
    messages: mediaBudgetProjection.messages,
  };
}

interface MediaBudgetProjectionOptions {
  latestRealUserMessageIndex?: number;
  maxMediaBytes?: number;
  preserveLatestUserMedia?: boolean;
}

export function projectMessagesForMediaBudget(
  messages: ModelInputMessage[],
  options: MediaBudgetProjectionOptions = {},
): MediaBudgetProjection {
  const maxMediaBytes = options.maxMediaBytes ?? DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES;
  if (!Number.isFinite(maxMediaBytes) || maxMediaBytes < 0) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Invalid model request media budget", {
      context: { maxMediaBytes },
      recoverable: true,
    });
  }
  const latestUserIndex =
    options.preserveLatestUserMedia === false
      ? -1
      : resolveLatestRealUserMessageIndex(messages, options.latestRealUserMessageIndex);
  const mediaBlocks = collectMediaBlocks(messages, latestUserIndex);
  const totalMediaBytes = sumMediaBytes(mediaBlocks);

  if (totalMediaBytes <= maxMediaBytes) {
    return {
      messages,
      omittedMediaCount: 0,
      projectedMediaBytes: totalMediaBytes,
      retainedMediaCount: mediaBlocks.length,
      totalMediaBytes,
    };
  }

  const protectedMedia = mediaBlocks.filter((block) => block.protected);
  const protectedMediaBytes = sumMediaBytes(protectedMedia);
  if (protectedMediaBytes > maxMediaBytes) {
    const errorCode = MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE_ERROR_CODE;
    const error = createCoreError(
      CoreErrorType.InvalidInput,
      "Current attachments are too large to send. Remove or compress attachments and try again.",
      {
        context: { code: errorCode, maxMediaBytes, protectedMediaBytes, totalMediaBytes },
        recoverable: true,
      },
    );
    // 跨进程只传通用 INVALID_INPUT 会丢失本地化语义；请求总量错误
    // 必须使用统一附件码，避免把 PDF 或混合附件误报成图片/视频错误。
    error.code = errorCode;
    throw error;
  }

  const retainedKeys = new Set(protectedMedia.map(mediaKey));
  let remainingBytes = maxMediaBytes - protectedMediaBytes;
  const historicalMedia = mediaBlocks
    .filter((block) => !block.protected)
    .sort(
      (left, right) => right.messageIndex - left.messageIndex || right.blockIndex - left.blockIndex,
    );
  for (const media of historicalMedia) {
    if (media.requestBytes > remainingBytes) continue;
    retainedKeys.add(mediaKey(media));
    remainingBytes -= media.requestBytes;
  }

  const messagesWithBudget = messages.map((message, messageIndex) => ({
    ...message,
    content: projectContent(message.content, messageIndex, retainedKeys),
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
    cacheControl: message.cacheControl ? { ...message.cacheControl } : undefined,
  }));
  const retainedMediaCount = retainedKeys.size;

  return {
    messages: messagesWithBudget,
    omittedMediaCount: mediaBlocks.length - retainedMediaCount,
    projectedMediaBytes: mediaBlocks
      .filter((block) => retainedKeys.has(mediaKey(block)))
      .reduce((total, block) => total + block.requestBytes, 0),
    retainedMediaCount,
    totalMediaBytes,
  };
}

function resolveLatestRealUserMessageIndex(
  messages: ModelInputMessage[],
  latestRealUserMessageIndex: number | undefined,
): number {
  // cacheControl 现在是 provider cache marker，latest real user 身份由
  // provider projection 传入的 request-local index 承接；-1 明确表示没有真实用户，缺失时才回退到文本启发式。
  if (
    latestRealUserMessageIndex !== undefined &&
    Number.isInteger(latestRealUserMessageIndex) &&
    latestRealUserMessageIndex >= -1 &&
    latestRealUserMessageIndex < messages.length
  ) {
    return latestRealUserMessageIndex;
  }
  return findLatestRealUserMessageIndex(messages);
}

export function logMediaBudgetProjection(
  logger: Logger | undefined,
  traceContext: TraceContext,
  projection: MediaBudgetProjection,
  options: { event: string; message: string },
): void {
  if (projection.omittedMediaCount === 0) return;
  logger?.debug(options.message, {
    ...traceContextToLogContext(traceContext),
    event: options.event,
    module: "core.runtime",
    status: "completed",
    omittedMediaCount: projection.omittedMediaCount,
    projectedMediaBytes: projection.projectedMediaBytes,
    retainedMediaCount: projection.retainedMediaCount,
    totalMediaBytes: projection.totalMediaBytes,
  });
}

function collectMediaBlocks(
  messages: ModelInputMessage[],
  latestUserIndex: number,
): MediaBlockRef[] {
  const mediaBlocks: MediaBlockRef[] = [];
  messages.forEach((message, messageIndex) => {
    if (!Array.isArray(message.content)) return;
    message.content.forEach((block, blockIndex) => {
      const requestBytes = mediaRequestBytes(block);
      if (requestBytes === 0) return;
      mediaBlocks.push({
        blockIndex,
        requestBytes,
        messageIndex,
        protected: messageIndex === latestUserIndex,
      });
    });
  });
  return mediaBlocks;
}

function projectContent(
  content: ModelMessageContent,
  messageIndex: number,
  retainedKeys: Set<string>,
): ModelMessageContent {
  if (!Array.isArray(content)) return content;

  const omittedBlockIndexes = new Set<number>();
  content.forEach((block, blockIndex) => {
    if (mediaRequestBytes(block) === 0) return;
    if (!retainedKeys.has(mediaKey({ blockIndex, messageIndex }))) {
      omittedBlockIndexes.add(blockIndex);
    }
  });

  const pairedTextIndexes = officialCuaImageRefIndexesForUnavailableMedia(
    content,
    omittedBlockIndexes,
  );

  return content.map((block, blockIndex) => {
    if (pairedTextIndexes.has(blockIndex)) {
      return { type: "text", text: "" };
    }
    if (mediaRequestBytes(block) === 0) return cloneContentBlock(block);
    const key = mediaKey({ blockIndex, messageIndex });
    if (retainedKeys.has(key)) return cloneContentBlock(block);
    return pairedTextIndexes.has(blockIndex + 1)
      ? officialCuaRasterUnavailableBlock()
      : mediaOmittedTextBlock(block);
  });
}

function mediaRequestBytes(block: ModelMessageContentBlock): number {
  if (block.type === "image" || block.type === "video") {
    return Buffer.byteLength(block.dataUrl, "utf8");
  }
  if (block.type === "file" && block.dataUrl && !block.text) {
    return Buffer.byteLength(block.dataUrl, "utf8");
  }
  return 0;
}

function mediaOmittedTextBlock(block: ModelMessageContentBlock): ModelMessageContentBlock {
  const placeholder = modelMessageContentToText([block]) || "[Attached media]";
  return {
    type: "text",
    text: `${placeholder}\n[Media omitted from provider request to keep the request body under the configured media budget.]`,
  };
}

function cloneContentBlock(block: ModelMessageContentBlock): ModelMessageContentBlock {
  switch (block.type) {
    case "image":
    case "video":
    case "file":
      return { ...block, source: block.source ? { ...block.source } : undefined };
    case "text":
    case "reasoning":
    case "resource_link":
      return { ...block };
  }
}

function sumMediaBytes(mediaBlocks: MediaBlockRef[]): number {
  return mediaBlocks.reduce((total, block) => total + block.requestBytes, 0);
}

function mediaKey(input: Pick<MediaBlockRef, "blockIndex" | "messageIndex">): string {
  return `${input.messageIndex}:${input.blockIndex}`;
}
