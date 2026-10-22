// ============================================================
// Message History - Maintains conversation context across turns
// ============================================================

import {
  type RuntimeInputPresentation,
  type ModelCallWrapper,
  type FilePart,
  modelMessageContentToText,
  type ModelCacheControl,
  type ModelMessageContent,
  type ModelMessageContentBlock,
  type Model,
  type ModelToolCall,
  type ModelReasoningContentBlock,
  type TokenUsageInfo,
} from "@zcode/contracts";
import {
  buildPromptAttachmentReminderBodies,
  type PromptAttachmentReminderInput,
} from "../system-reminder/prompt-attachment.js";
import { parseAgentListingDelta, type AgentListingDelta } from "./agent-listing-metadata.js";
import { SYSTEM_REMINDER_SOURCES, type SystemReminderSource } from "../system-reminder/source.js";

// Tool call from model (simple type, no brand)
export interface ToolCallInput {
  modelCallWrapper?: ModelCallWrapper;
  id: string;
  name: string;
  input: unknown;
}

// 仅模型协议出口和原始调用诊断使用；内部消费者始终读取目标 name/input。
export function toModelToolCall(call: ToolCallInput): ModelToolCall {
  if (!call.modelCallWrapper) return call;
  return {
    id: call.id,
    name: call.modelCallWrapper,
    input: { name: call.name, input: call.input },
  };
}

export type ReasoningContentInput = ModelReasoningContentBlock;

export interface ModelInputMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ModelMessageContent;
  cacheControl?: ModelCacheControl;
  toolCalls?: ToolCallInput[];
  toolCallId?: string;
  toolName?: string;
  modelCallWrapper?: ModelCallWrapper;
  isError?: boolean;
  providerId?: Model["providerId"];
  modelId?: Model["modelId"];
}

export type RuntimeMessageSource =
  | SystemReminderSource
  | "shared_context"
  | "real_user"
  | "legacy_synthetic";

export interface RuntimeMessageMetadata {
  compactBoundary?: { boundaryId: string; preCompactDiscoveredTools?: readonly string[] };
  toolSearchAnnouncement?: {
    addedNames: readonly string[];
    removedNames: readonly string[];
    readdedNames: readonly string[];
  };
  source: RuntimeMessageSource;
  agentListingDelta?: AgentListingDelta;
  inputPresentation?: RuntimeInputPresentation;
}

export interface RuntimeMessageMessageEntry {
  kind?: "message";
  message: ModelInputMessage;
  metadata?: RuntimeMessageMetadata;
  /** 已提交 assistant 自己的 provider tokens；不会发送到 provider。 */
  tokens?: TokenUsageInfo;
  /** 仅在当前 query 内生效；不得进入 canonical history 或 Session persistence。 */
  queryScope?: "output_token_continuation";
}

export interface RuntimeAttachmentEntry {
  kind: "attachment";
  content: string;
  cacheControl?: ModelCacheControl;
  metadata: RuntimeMessageMetadata;
}

export type RuntimeMessageEntry = RuntimeMessageMessageEntry | RuntimeAttachmentEntry;

export interface CacheStats {
  totalMessages: number;
  cachedMessages: number;
  lastCacheHit: boolean;
  cacheReadTokens?: number;
}

// ============================================================
// Message History Interface
// ============================================================

export interface MessageHistory {
  // Initialize with optional system prompt or context prefix messages
  init(systemPromptOrMessages?: string | Array<ModelInputMessage | RuntimeMessageEntry>): void;

  // Add user message
  addUser(content: ModelMessageContent, metadata?: RuntimeMessageMetadata): void;

  // Add structured internal context that provider projection renders at request time.
  addAttachment(source: SystemReminderSource, content: string): void;

  // Add already-built runtime entries while preserving their source metadata.
  addEntries(entries: readonly RuntimeMessageEntry[]): void;

  // Add assistant message (may include tool calls)
  addAssistant(
    content: string,
    toolCalls?: ToolCallInput[],
    reasoning?: ReasoningContentInput[],
    model?: Pick<Model, "providerId" | "modelId">,
    tokens?: TokenUsageInfo,
  ): void;

  // Add tool result
  addToolResult(
    toolCallId: string,
    toolName: string,
    content: ModelMessageContent,
    success: boolean,
    isError?: boolean,
    modelCallWrapper?: ModelCallWrapper,
  ): void;

  // 借用当前权威 entries，只允许同步只读；跨异步边界时由调用方做数组浅快照。
  borrowReadOnlyRuntimeEntries(): readonly RuntimeMessageEntry[];

  // 创建可写的防御性副本；Runtime 内部普通只读点应使用 borrowReadOnlyRuntimeEntries。
  toRuntimeEntries(): RuntimeMessageEntry[];

  // Replace the active provider-visible history after compact/rewind.
  replaceMessages(messages: readonly (ModelInputMessage | RuntimeMessageEntry)[]): void;

  // Get current message count
  getMessageCount(): number;

  // Cache management
  getCacheStats(): CacheStats;
  setCacheHit(tokens?: number): void;
  setCacheMiss(): void;

  // Reset for new turn
  reset(): void;
}

// ============================================================
// Message History Implementation
// ============================================================

export class MessageHistoryImpl implements MessageHistory {
  private entries: RuntimeMessageEntry[] = [];
  private cacheStats: CacheStats = {
    totalMessages: 0,
    cachedMessages: 0,
    lastCacheHit: false,
  };

  init(systemPromptOrMessages?: string | Array<ModelInputMessage | RuntimeMessageEntry>): void {
    this.entries = [];

    if (typeof systemPromptOrMessages === "string" && systemPromptOrMessages.length > 0) {
      this.entries.push({
        message: {
          role: "system",
          content: systemPromptOrMessages,
        },
      });
    } else if (Array.isArray(systemPromptOrMessages)) {
      this.entries.push(...systemPromptOrMessages.map(cloneEntryInput));
    }

    this.cacheStats = {
      totalMessages: this.entries.length,
      cachedMessages: countContextPrefixMessages(this.entries),
      lastCacheHit: false,
    };
  }

  addUser(content: ModelMessageContent, metadata?: RuntimeMessageMetadata): void {
    this.entries.push(createRuntimeUserEntry(content, metadata));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addAttachment(source: SystemReminderSource, content: string): void {
    this.entries.push(systemReminderAttachmentEntry(source, content));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addEntries(entries: readonly RuntimeMessageEntry[]): void {
    this.entries.push(...entries.map(cloneRuntimeMessageEntry));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addAssistant(
    content: string,
    toolCalls?: ToolCallInput[],
    reasoning?: ReasoningContentInput[],
    model?: Pick<Model, "providerId" | "modelId">,
    tokens?: TokenUsageInfo,
  ): void {
    const reasoningBlocks = reasoning?.map((block) => cloneReasoningBlock(block)) ?? [];
    this.entries.push({
      message: {
        role: "assistant",
        content:
          reasoningBlocks.length > 0
            ? [
                ...reasoningBlocks,
                ...(content.length > 0 ? [{ type: "text" as const, text: content }] : []),
              ]
            : content,
        toolCalls: toolCalls?.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input,
          ...(tc.modelCallWrapper ? { modelCallWrapper: tc.modelCallWrapper } : {}),
        })),
        ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
      },
      ...(tokens ? { tokens: cloneTokenUsageInfo(tokens) } : {}),
    });
    this.cacheStats.totalMessages = this.entries.length;
  }

  addToolResult(
    toolCallId: string,
    toolName: string,
    content: ModelMessageContent,
    success: boolean,
    isError = !success,
    modelCallWrapper?: ModelCallWrapper,
  ): void {
    this.entries.push(
      createRuntimeToolResultEntry(toolCallId, toolName, content, isError, modelCallWrapper),
    );
    this.cacheStats.totalMessages = this.entries.length;
  }

  borrowReadOnlyRuntimeEntries(): readonly RuntimeMessageEntry[] {
    return this.entries;
  }

  toRuntimeEntries(): RuntimeMessageEntry[] {
    return this.entries.map(cloneRuntimeMessageEntry);
  }

  replaceMessages(messages: readonly (ModelInputMessage | RuntimeMessageEntry)[]): void {
    this.entries = messages.map(cloneEntryInput);
    this.cacheStats = {
      totalMessages: this.entries.length,
      cachedMessages: countContextPrefixMessages(this.entries),
      lastCacheHit: false,
    };
  }

  getMessageCount(): number {
    return this.entries.length;
  }

  getCacheStats(): CacheStats {
    return { ...this.cacheStats };
  }

  setCacheHit(tokens?: number): void {
    this.cacheStats.lastCacheHit = true;
    this.cacheStats.cacheReadTokens = tokens;
    // Mark all messages as potentially cached
    this.cacheStats.cachedMessages = this.entries.length;
  }

  setCacheMiss(): void {
    this.cacheStats.lastCacheHit = false;
    this.cacheStats.cacheReadTokens = undefined;
    this.cacheStats.cachedMessages = countContextPrefixMessages(this.entries);
  }

  reset(): void {
    const contextPrefixMessages = this.entries.slice(0, countContextPrefixMessages(this.entries));
    this.entries = contextPrefixMessages.map(cloneRuntimeMessageEntry);
    this.cacheStats = {
      totalMessages: contextPrefixMessages.length,
      cachedMessages: contextPrefixMessages.length,
      lastCacheHit: false,
    };
  }
}

export function countContextPrefixMessages(
  messagesOrEntries: readonly (ModelInputMessage | RuntimeMessageEntry)[],
): number {
  let count = 0;
  for (const item of messagesOrEntries) {
    if (isRuntimeAttachmentEntry(item)) {
      if (item.metadata.source === "context_prefix" || item.metadata.source === "skills_listing") {
        count++;
        continue;
      }
      break;
    }
    const message = messageFromEntryInput(item);
    const metadata = metadataFromEntryInput(item);
    if (message.role === "system") {
      count++;
      continue;
    }
    if (message.role !== "user") break;
    if (metadata) {
      if (metadata.source === "context_prefix" || metadata.source === "skills_listing") {
        count++;
        continue;
      }
      break;
    }
    if (isMetaUserContext(message.content)) {
      count++;
      continue;
    }
    break;
  }
  return count;
}

function isMetaUserContext(content: ModelMessageContent): boolean {
  return modelMessageContentToText(content).trimStart().startsWith("<system-reminder>");
}

export function systemReminderRuntimeMetadata(
  source: SystemReminderSource,
): RuntimeMessageMetadata {
  return { source };
}

export function realUserRuntimeMetadata(): RuntimeMessageMetadata {
  return { source: "real_user" };
}

export function legacySyntheticRuntimeMetadata(): RuntimeMessageMetadata {
  return { source: "legacy_synthetic" };
}

export function todoReminderRuntimeMetadata(): RuntimeMessageMetadata {
  return { source: "todo_reminder" };
}

export function systemReminderAttachmentEntry(
  source: SystemReminderSource,
  content: string,
): RuntimeAttachmentEntry {
  return {
    kind: "attachment",
    content,
    metadata: systemReminderRuntimeMetadata(source),
  };
}

export function createRuntimeUserEntry(
  content: ModelMessageContent,
  metadata?: RuntimeMessageMetadata,
): RuntimeMessageMessageEntry {
  return {
    message: {
      role: "user",
      content,
    },
    metadata: cloneRuntimeMessageMetadata(metadata),
  };
}

export function createRuntimeAssistantEntry(
  content: string,
  toolCalls?: readonly ToolCallInput[],
  reasoning?: readonly ReasoningContentInput[],
  model?: Pick<Model, "providerId" | "modelId">,
  tokens?: TokenUsageInfo,
): RuntimeMessageMessageEntry {
  const reasoningBlocks = reasoning?.map((block) => cloneReasoningBlock(block)) ?? [];
  return {
    message: {
      role: "assistant",
      content:
        reasoningBlocks.length > 0
          ? [
              ...reasoningBlocks,
              ...(content.length > 0 ? [{ type: "text" as const, text: content }] : []),
            ]
          : content,
      toolCalls: toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
        ...(toolCall.modelCallWrapper ? { modelCallWrapper: toolCall.modelCallWrapper } : {}),
      })),
      ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
    },
    ...(tokens ? { tokens: cloneTokenUsageInfo(tokens) } : {}),
  };
}

export function createRuntimeToolResultEntry(
  toolCallId: string,
  toolName: string,
  content: ModelMessageContent,
  isError: boolean,
  modelCallWrapper?: ModelCallWrapper,
): RuntimeMessageMessageEntry {
  return {
    message: {
      role: "tool",
      content,
      toolCallId,
      toolName,
      ...(modelCallWrapper ? { modelCallWrapper } : {}),
      isError,
    },
  };
}

export function isKnownSystemReminderSource(value: unknown): value is SystemReminderSource {
  return (
    typeof value === "string" && SYSTEM_REMINDER_SOURCES.includes(value as SystemReminderSource)
  );
}

function cloneEntryInput(input: ModelInputMessage | RuntimeMessageEntry): RuntimeMessageEntry {
  if (isRuntimeMessageEntry(input)) {
    return cloneRuntimeMessageEntry(input);
  }
  return { message: cloneModelInputMessage(input) };
}

export function cloneRuntimeMessageEntry(entry: RuntimeMessageEntry): RuntimeMessageEntry {
  if (entry.kind === "attachment") {
    return {
      kind: "attachment",
      content: entry.content,
      cacheControl: entry.cacheControl ? { ...entry.cacheControl } : undefined,
      metadata: cloneRuntimeMessageMetadata(entry.metadata)!,
    };
  }
  return {
    message: cloneModelInputMessage(entry.message),
    metadata: cloneRuntimeMessageMetadata(entry.metadata),
    ...(entry.tokens ? { tokens: cloneTokenUsageInfo(entry.tokens) } : {}),
    ...(entry.queryScope ? { queryScope: entry.queryScope } : {}),
  };
}

/**
 * Compact 之后 preserved assistant 的 provider usage 仍属于被替换的旧前缀。
 * 只对 projection 副本清零，不能改写 SessionStore 中的原始 tokens。
 */
export function invalidateRuntimeTokenUsage(tokens: TokenUsageInfo): TokenUsageInfo {
  return {
    ...tokens,
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0,
    },
  };
}

function cloneTokenUsageInfo(tokens: TokenUsageInfo): TokenUsageInfo {
  return {
    ...tokens,
    cache: { ...tokens.cache },
  };
}

export function cloneRuntimeMessageMetadata(
  metadata: RuntimeMessageMetadata | undefined,
): RuntimeMessageMetadata | undefined {
  if (!metadata) return undefined;
  const { agentListingDelta, ...rest } = metadata;
  const delta = parseAgentListingDelta(agentListingDelta);
  return {
    ...rest,
    ...(delta ? { agentListingDelta: delta } : {}),
    ...(metadata.compactBoundary
      ? {
          compactBoundary: {
            ...metadata.compactBoundary,
            preCompactDiscoveredTools: metadata.compactBoundary.preCompactDiscoveredTools
              ? [...metadata.compactBoundary.preCompactDiscoveredTools]
              : undefined,
          },
        }
      : {}),
    ...(metadata.toolSearchAnnouncement
      ? {
          toolSearchAnnouncement: {
            addedNames: [...metadata.toolSearchAnnouncement.addedNames],
            removedNames: [...metadata.toolSearchAnnouncement.removedNames],
            readdedNames: [...metadata.toolSearchAnnouncement.readdedNames],
          },
        }
      : {}),
  };
}

function messageFromEntryInput(input: ModelInputMessage | RuntimeMessageEntry): ModelInputMessage {
  if (isRuntimeAttachmentEntry(input)) {
    throw new Error("Runtime attachment entries do not have a direct model message representation");
  }
  return isRuntimeMessageEntry(input) ? input.message : input;
}

function metadataFromEntryInput(
  input: ModelInputMessage | RuntimeMessageEntry,
): RuntimeMessageMetadata | undefined {
  return isRuntimeMessageEntry(input) ? input.metadata : undefined;
}

function isRuntimeMessageEntry(
  input: ModelInputMessage | RuntimeMessageEntry,
): input is RuntimeMessageEntry {
  return "message" in input || ("kind" in input && input.kind === "attachment");
}

export function isRuntimeAttachmentEntry(
  input: ModelInputMessage | RuntimeMessageEntry,
): input is RuntimeAttachmentEntry {
  return isRuntimeMessageEntry(input) && "kind" in input && input.kind === "attachment";
}

export function cloneModelInputMessage(message: ModelInputMessage): ModelInputMessage {
  const next: ModelInputMessage = {
    role: message.role,
    content: cloneModelMessageContent(message.content),
  };
  if (message.cacheControl) next.cacheControl = { ...message.cacheControl };
  if (message.toolCalls) next.toolCalls = message.toolCalls.map((toolCall) => ({ ...toolCall }));
  if (message.toolCallId) next.toolCallId = message.toolCallId;
  // 空字符串是可恢复调用的 provider 原始名称，不能在 request-local clone 时按 falsy 丢失。
  if (message.toolName !== undefined) next.toolName = message.toolName;
  if (message.modelCallWrapper) next.modelCallWrapper = message.modelCallWrapper;
  if (message.isError !== undefined) next.isError = message.isError;
  if (message.providerId) next.providerId = message.providerId;
  if (message.modelId) next.modelId = message.modelId;
  return next;
}

function cloneReasoningBlock(block: ReasoningContentInput): ReasoningContentInput {
  return {
    ...block,
    providerOptions: block.providerOptions ? { ...block.providerOptions } : undefined,
  };
}

export function cloneModelMessageContent(content: ModelMessageContent): ModelMessageContent {
  if (typeof content === "string") return content;
  return content.map(cloneModelMessageContentBlock);
}

function cloneModelMessageContentBlock(block: ModelMessageContentBlock): ModelMessageContentBlock {
  if (block.type === "reasoning") {
    return cloneReasoningBlock(block);
  }
  if ("source" in block && block.source) {
    return { ...block, source: { ...block.source } };
  }
  return { ...block };
}

// ============================================================
// Factory
// ============================================================

export function createMessageHistory(): MessageHistory {
  return new MessageHistoryImpl();
}

/** 用户附件的已解析内容及持久化来源；不依赖 runtime 或文件读取。 */
export type UserMessageAttachment = Pick<FilePart, "filename" | "mime" | "source" | "metadata"> & {
  contentBlock: ModelMessageContentBlock;
};

// 首发、队列消费和恢复曾分别组装，导致正文、PDF、路径引用顺序及文本附件语义漂移。
// 统一在消息历史边界组装；调用方只负责解析内容，不再各自分组。
export function buildUserMessageEntries(
  input: ModelMessageContent,
  attachments: readonly UserMessageAttachment[],
): [RuntimeMessageMessageEntry, ...RuntimeAttachmentEntry[]] {
  const realUserBlocks: ModelMessageContentBlock[] = [];
  const pastedImageBlocks: ModelMessageContentBlock[] = [];
  const promptAttachmentEntries: RuntimeAttachmentEntry[] = [];

  for (const attachment of attachments) {
    if (isPastedInlineImageAttachment(attachment)) {
      pastedImageBlocks.push(attachment.contentBlock);
      continue;
    }

    const promptAttachmentInput = promptAttachmentInputForResolvedAttachment(attachment);
    if (promptAttachmentInput) {
      const reminderBody = buildPromptAttachmentReminderBodies(promptAttachmentInput).join("\n");
      promptAttachmentEntries.push(
        systemReminderAttachmentEntry("prompt_attachment", reminderBody),
      );
      continue;
    }

    if (isFailedTextAttachmentPlaceholder(attachment)) {
      continue;
    }

    realUserBlocks.push(attachment.contentBlock);
  }

  const blocks: ModelMessageContentBlock[] = [];
  if (typeof input === "string") {
    if (input.length > 0) blocks.push({ type: "text", text: input });
  } else {
    blocks.push(...input.filter((block) => block.type !== "text" || block.text.length > 0));
  }
  blocks.push(...realUserBlocks, ...pastedImageBlocks);

  return [
    {
      message: {
        role: "user",
        content: normalizeRealUserContent(blocks),
      },
      metadata: realUserRuntimeMetadata(),
    },
    ...promptAttachmentEntries,
  ];
}

function normalizeRealUserContent(
  blocks: readonly ModelMessageContentBlock[],
): ModelMessageContent {
  if (blocks.length === 0) return "";
  if (blocks.length === 1 && blocks[0]!.type === "text") {
    return blocks[0]!.text;
  }
  return blocks.map((block) => ({ ...block })) as ModelMessageContentBlock[];
}

export function isPastedInlineImageAttachment(attachment: UserMessageAttachment): boolean {
  if (attachment.contentBlock.type === "image") {
    // 冷恢复会把本地媒体重建为 inline；分组必须使用持久化来源，不能据此把本地图片当成粘贴图片。
    return !attachment.source && attachment.contentBlock.source?.kind === "inline";
  }
  return (
    attachment.contentBlock.type === "text" &&
    attachment.mime.startsWith("image/") &&
    /^\[Attached image\/[^:]+: \[image #\d+\]\]$/u.test(attachment.contentBlock.text)
  );
}

function shouldAddReadLikePromptAttachmentReminder(
  attachment: UserMessageAttachment,
): attachment is UserMessageAttachment & {
  contentBlock: Extract<ModelMessageContentBlock, { type: "text" }>;
  source: NonNullable<UserMessageAttachment["source"]>;
} {
  if (attachment.contentBlock.type !== "text") return false;
  if (!attachment.mime.startsWith("text/")) return false;
  if (!attachment.source) return false;
  if (attachment.metadata?.storageKind !== "inline") return false;
  if (
    attachment.metadata?.recoverability !== "provider_ready" &&
    attachment.metadata?.recoverability !== "preview_only"
  ) {
    return false;
  }
  return attachment.metadata?.preview?.text === attachment.contentBlock.text;
}

export function promptAttachmentInputForResolvedAttachment(
  attachment: UserMessageAttachment,
): (PromptAttachmentReminderInput & { content: string; kind: "file" | "inline_text" }) | undefined {
  if (shouldAddReadLikePromptAttachmentReminder(attachment)) {
    return {
      content: attachment.contentBlock.text,
      kind: "file",
      // provider-visible 的 Read 输入要和用户提交的附件引用一致。
      // local file 的 filename 只是展示名；只有缺少 source 时才用它兜底，避免 live/hydrate 轨迹漂移。
      label: attachment.source.text.value ?? attachment.filename,
      preview: attachment.metadata?.preview,
    };
  }

  if (shouldAddInlinePromptAttachmentReminder(attachment)) {
    return {
      content: attachment.contentBlock.text,
      kind: "inline_text",
      label: attachment.filename,
      preview: attachment.metadata?.preview,
    };
  }

  return undefined;
}

function shouldAddInlinePromptAttachmentReminder(
  attachment: UserMessageAttachment,
): attachment is UserMessageAttachment & {
  contentBlock: Extract<ModelMessageContentBlock, { type: "text" }>;
} {
  return (
    attachment.contentBlock.type === "text" &&
    attachment.mime.startsWith("text/") &&
    !attachment.source
  );
}

export function isFailedTextAttachmentPlaceholder(attachment: UserMessageAttachment): boolean {
  return (
    attachment.contentBlock.type === "text" &&
    attachment.mime.startsWith("text/") &&
    attachment.metadata?.errorCode === "attachment_read_failed"
  );
}
