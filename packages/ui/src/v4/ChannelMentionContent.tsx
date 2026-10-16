import { Fragment } from "react";
import { AtSign } from "lucide-react";
import {
  channelContentText,
  type ChannelContentPart,
  type BotGroupInputSource,
} from "@zcode/shared";
import { PROMPT_MENTION_BASE_CLASS_NAME } from "@/mentions/mentionChip.js";

/** 只渲染可信消息节点；复制出的 @name 普通文本不能恢复平台身份。 */
export function ChannelMentionContent({
  parts,
  text,
}: {
  parts?: readonly ChannelContentPart[];
  text: string;
}) {
  if (!parts || channelContentText(parts) !== text) return <>{text}</>;
  return (
    <span className="whitespace-pre-wrap break-words">
      {parts.map((part, index) =>
        part.type === "text" ? (
          <Fragment key={index}>{part.text}</Fragment>
        ) : (
          <span
            key={`${part.refId}:${index}`}
            data-channel-mention={part.channel}
            title={`${part.name} · ${part.channel === "lark" ? "Lark" : "飞书 / Feishu"}`}
            className={`${PROMPT_MENTION_BASE_CLASS_NAME} mx-0.5 max-w-full rounded bg-surface-hover px-1 text-foreground`}
          >
            <AtSign className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{part.name}</span>
            <span className="text-ui-xs text-foreground-subtle">
              {part.channel === "lark" ? "Lark" : "Feishu"}
            </span>
          </span>
        ),
      )}
    </span>
  );
}

/** 合批队列按原发送者与正文顺序投影，不能把末条的节点套到整批文本上。 */
export function BotChannelMessageContent({
  source,
  text,
}: {
  source?: BotGroupInputSource;
  text: string;
}) {
  const messages = source?.messages;
  const parts =
    messages && messages.length > 1
      ? messages.flatMap((message, index): ChannelContentPart[] => [
          {
            type: "text",
            text: `${index ? "\n\n" : ""}${message.senderName || message.senderId}: `,
          },
          ...(message.contentParts && channelContentText(message.contentParts) === message.text
            ? message.contentParts
            : [{ type: "text" as const, text: message.text }]),
        ])
      : (messages?.[0]?.contentParts ?? source?.contentParts);
  return <ChannelMentionContent parts={parts} text={text} />;
}
