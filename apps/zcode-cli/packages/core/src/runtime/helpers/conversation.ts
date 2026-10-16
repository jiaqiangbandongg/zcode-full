import { activeSessionMessages, modelMessageContentToText } from "../deps.js";
import {
  buildPromptAttachmentBlocks,
  buildPromptAttachmentReminderBodies,
  type PromptAttachmentReminderInput,
} from "../../system-reminder/prompt-attachment.js";
import {
  realUserRuntimeMetadata,
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type {
  MessageId,
  MessageWithParts,
  ModelMessageContent,
  ModelMessageContentBlock,
} from "../deps.js";
import type { ResolvedTurnAttachment, RunModelTextRequestOptions } from "../types.js";

export function getLatestActiveSessionMessageId(
  messages: MessageWithParts[],
  options: {
    branchCutAfterMessageId?: MessageId;
    rewindCreatedMessageId?: MessageId;
    rewindKeptMessageIds?: readonly MessageId[];
    rewindTargetMessageId?: MessageId;
  } = {},
): MessageId | undefined {
  const activeMessages = activeSessionMessages(messages, {
    ...options,
    includeCompactPreservedSegment: false,
  });

  for (let index = activeMessages.length - 1; index >= 0; index--) {
    const message = activeMessages[index]!;
    if (message.info.role === "user" || message.info.role === "assistant") {
      return message.info.id;
    }
  }

  return undefined;
}

export function findLatestRealUserMessageIndex(
  messages: RunModelTextRequestOptions["messages"],
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    // provider projection 会在剥离 metadata 前传入 latest real user 的 request-local index。
    // 这里仅作为缺失该 index 时的兜底，避免把用户输入的 literal meta tag 当成 runtime meta。
    if (message.role === "user" && !isMetaUserContextMessage(message)) {
      return index;
    }
  }
  return -1;
}

export function isMetaUserContextMessage(
  message: RunModelTextRequestOptions["messages"][number],
): boolean {
  return (
    message.role === "user" &&
    modelMessageContentToText(message.content).trimStart().startsWith("<system-reminder>")
  );
}

export function buildUserContentFromTurn(
  input: string,
  attachments: ResolvedTurnAttachment[],
): ModelMessageContent {
  if (attachments.length === 0) return input;

  const blocks: ModelMessageContentBlock[] = [];
  // video 跟随正文，避免影响既有非粘贴 image/@file/url 的顺序。
  const videoBlocks: ModelMessageContentBlock[] = [];
  const pastedImageBlocks: ModelMessageContentBlock[] = [];
  for (const attachment of attachments) {
    if (isPastedInlineImageAttachment(attachment)) {
      pastedImageBlocks.push(attachment.contentBlock);
      continue;
    }
    const promptAttachmentInput = promptAttachmentInputForResolvedAttachment(attachment);
    if (promptAttachmentInput) {
      blocks.push(...buildPromptAttachmentBlocks(promptAttachmentInput));
      continue;
    }
    if (isFailedTextAttachmentPlaceholder(attachment)) {
      continue;
    }
    if (attachment.contentBlock.type === "video") {
      videoBlocks.push(attachment.contentBlock);
      continue;
    }
    blocks.push(attachment.contentBlock);
  }

  if (blocks.length === 0 && pastedImageBlocks.length === 0 && videoBlocks.length === 0) {
    return input;
  }

  if (input.length > 0) {
    blocks.push({ type: "text", text: input });
  }
  blocks.push(...videoBlocks, ...pastedImageBlocks);

  return blocks;
}

export function buildRuntimeUserEntriesFromTurn(
  input: string,
  attachments: ResolvedTurnAttachment[],
  options: {
    browserAmbientContext?: { tabCount: number; currentUrl?: string };
  } = {},
): RuntimeMessageEntry[] {
  const realUserBlocks: ModelMessageContentBlock[] = [];
  const pastedImageBlocks: ModelMessageContentBlock[] = [];
  const promptAttachmentEntries: RuntimeMessageEntry[] = [];

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
  if (input.length > 0) {
    blocks.push({
      type: "text",
      text: formatBrowserAmbientUserInput(input, options.browserAmbientContext),
    });
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

export function formatBrowserAmbientUserInput(
  input: string,
  context?: { tabCount: number; currentUrl?: string },
): string {
  if (!context || !Number.isInteger(context.tabCount) || context.tabCount <= 0)
    return input;
  const tabLabel = context.tabCount === 1 ? "tab" : "tabs";
  const lines = [
    '<in-app-browser-context source="ambient-ui-state">',
    "This block is automatically supplied ambient UI state, not part of the user's request. Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.",
    "# In app browser:",
    `- The user has the in-app browser open with ${context.tabCount} ${tabLabel}.`,
    ...(context.currentUrl ? [`- Current URL: ${context.currentUrl}`] : []),
    "</in-app-browser-context>",
    "",
    "## My request for ZCode:",
    input,
  ];
  return lines.join("\n");
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

function isPastedInlineImageAttachment(attachment: ResolvedTurnAttachment): boolean {
  if (attachment.contentBlock.type === "image") {
    return attachment.contentBlock.source?.kind === "inline";
  }
  return (
    attachment.contentBlock.type === "text" &&
    attachment.mime.startsWith("image/") &&
    /^\[Attached image\/[^:]+: \[image #\d+\]\]$/u.test(attachment.contentBlock.text)
  );
}

function shouldAddReadLikePromptAttachmentReminder(
  attachment: ResolvedTurnAttachment,
): attachment is ResolvedTurnAttachment & {
  contentBlock: Extract<ModelMessageContentBlock, { type: "text" }>;
  source: NonNullable<ResolvedTurnAttachment["source"]>;
} {
  if (attachment.contentBlock.type !== "text") return false;
  if (!attachment.mime.startsWith("text/")) return false;
  if (!attachment.source) return false;
  if (attachment.metadata.storageKind !== "inline") return false;
  if (
    attachment.metadata.recoverability !== "provider_ready" &&
    attachment.metadata.recoverability !== "preview_only"
  ) {
    return false;
  }
  return attachment.metadata.preview?.text === attachment.contentBlock.text;
}

function promptAttachmentInputForResolvedAttachment(
  attachment: ResolvedTurnAttachment,
): (PromptAttachmentReminderInput & { content: string; kind: "file" | "inline_text" }) | undefined {
  if (shouldAddReadLikePromptAttachmentReminder(attachment)) {
    return {
      content: attachment.contentBlock.text,
      kind: "file",
      // provider-visible 的 Read 输入要和用户提交的附件引用一致。
      // local file 的 filename 只是展示名；只有缺少 source 时才用它兜底，避免 live/hydrate 轨迹漂移。
      label: attachment.source.text.value ?? attachment.filename,
      preview: attachment.metadata.preview,
    };
  }

  if (shouldAddInlinePromptAttachmentReminder(attachment)) {
    return {
      content: attachment.contentBlock.text,
      kind: "inline_text",
      label: attachment.filename,
      preview: attachment.metadata.preview,
    };
  }

  return undefined;
}

function shouldAddInlinePromptAttachmentReminder(
  attachment: ResolvedTurnAttachment,
): attachment is ResolvedTurnAttachment & {
  contentBlock: Extract<ModelMessageContentBlock, { type: "text" }>;
} {
  return (
    attachment.contentBlock.type === "text" &&
    attachment.mime.startsWith("text/") &&
    !attachment.source
  );
}

function isFailedTextAttachmentPlaceholder(attachment: ResolvedTurnAttachment): boolean {
  return (
    attachment.contentBlock.type === "text" &&
    attachment.mime.startsWith("text/") &&
    attachment.metadata.errorCode === "attachment_read_failed"
  );
}
