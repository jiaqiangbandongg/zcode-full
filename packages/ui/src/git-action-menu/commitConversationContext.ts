import type { GitCommitMessageConversationContext } from "@zcode/shared";

const MAX_COMMIT_CONVERSATION_MESSAGES = 12;
const MAX_COMMIT_CONVERSATION_MESSAGE_CHARS = 600;
const MAX_COMMIT_CONVERSATION_TOTAL_CHARS = 4_000;

interface GitCommitConversationMessageSource {
  role: "user" | "assistant";
  content?: string | null;
  mailboxMessage?: { content?: string | null } | null;
  parts?: readonly { type: string; content?: string | null }[] | null;
  syntheticTimeline?: unknown;
  uiTimeline?: unknown;
}

export function buildGitCommitMessageConversationContext(params: {
  sessionId?: string | null;
  messages: readonly GitCommitConversationMessageSource[];
}): GitCommitMessageConversationContext | null {
  const normalizedMessages = params.messages
    .map((message) => {
      const content = readVisibleConversationMessageContent(message);
      return content ? { role: message.role, content } : null;
    })
    .filter((message): message is { role: "user" | "assistant"; content: string } =>
      Boolean(message),
    );

  const selectedMessages: GitCommitMessageConversationContext["messages"] = [];
  let totalChars = 0;

  for (
    let index = normalizedMessages.length - 1;
    index >= 0 && selectedMessages.length < MAX_COMMIT_CONVERSATION_MESSAGES;
    index -= 1
  ) {
    const message = normalizedMessages[index];
    if (!message) {
      continue;
    }

    const content = clipConversationText(
      message.content,
      MAX_COMMIT_CONVERSATION_MESSAGE_CHARS,
    );
    const nextCost = content.length + message.role.length + 8;
    if (
      selectedMessages.length > 0 &&
      totalChars + nextCost > MAX_COMMIT_CONVERSATION_TOTAL_CHARS
    ) {
      break;
    }

    selectedMessages.push({ role: message.role, content });
    totalChars += nextCost;
  }

  if (selectedMessages.length === 0) {
    return null;
  }

  selectedMessages.reverse();
  const sessionId = params.sessionId?.trim();
  return {
    ...(sessionId ? { sessionId } : {}),
    omittedMessageCount: Math.max(0, normalizedMessages.length - selectedMessages.length),
    messages: selectedMessages,
  };
}

function readVisibleConversationMessageContent(
  message: GitCommitConversationMessageSource,
): string {
  if (message.syntheticTimeline || message.uiTimeline) {
    return "";
  }

  const directContent = normalizeConversationText(message.content ?? "");
  if (directContent) {
    return directContent;
  }

  const partContent = normalizeConversationText(
    (message.parts ?? [])
      .filter((part) => part.type === "content" && typeof part.content === "string")
      .map((part) => part.content)
      .join("\n"),
  );
  if (partContent) {
    return partContent;
  }

  return normalizeConversationText(message.mailboxMessage?.content ?? "");
}

function normalizeConversationText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function clipConversationText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 30)).trimEnd()}\n...message truncated...`;
}
