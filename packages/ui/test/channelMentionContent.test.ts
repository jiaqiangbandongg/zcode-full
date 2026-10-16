// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChannelMentionContent, BotChannelMessageContent } from "@/v4/ChannelMentionContent.js";
import type { ChannelContentPart } from "@zcode/shared";
const parts: ChannelContentPart[] = [
  { type: "text", text: "帮我 " },
  {
    type: "channelMention",
    refId: "m1",
    name: "Ryan Bot",
    channel: "feishu",
    targetId: "ou_target",
    idType: "open_id",
    entityType: "unknown",
  },
];
describe("native channel mention rendering", () => {
  it("renders a native node without exposing platform IDs", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelMentionContent, { parts, text: "帮我 @Ryan Bot" }),
    );
    expect(html).toContain('data-channel-mention="feishu"');
    expect(html).toContain("Ryan Bot");
    expect(html).not.toContain("ou_target");
  });
  it("renders original mentions in a multi-user queue projection", () => {
    const source = {
      botId: "bot",
      provider: "feishu" as const,
      chatId: "chat",
      threadId: "topic",
      senderId: "bob",
      senderName: "Bob",
      messageId: "b",
      messages: [
        {
          senderId: "alice",
          senderName: "Alice",
          messageId: "a",
          text: "帮我 @Ryan Bot",
          contentParts: parts,
          attachmentIndexes: [],
        },
        { senderId: "bob", senderName: "Bob", messageId: "b", text: "补充", attachmentIndexes: [] },
      ],
    };
    const html = renderToStaticMarkup(
      createElement(BotChannelMessageContent, {
        source,
        text: "Alice: 帮我 @Ryan Bot\n\nBob: 补充",
      }),
    );
    expect(html).toContain('data-channel-mention="feishu"');
    expect(html).toContain("Bob: 补充");
  });
  it("does not reuse identity after text is edited", () => {
    const html = renderToStaticMarkup(
      createElement(ChannelMentionContent, { parts, text: "帮我 @Alice" }),
    );
    expect(html).not.toContain("data-channel-mention");
    expect(html).toContain("Alice");
  });
});
