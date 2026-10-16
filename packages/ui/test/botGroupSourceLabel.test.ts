import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotGroupMemberNamesContext } from "@/v4/BotGroupMemberNamesContext.js";
import { BotGroupSourceLabel } from "@/v4/BotGroupSourceLabel.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

describe("group input attribution", () => {
  it.each(["zh-CN", "en-US"] as const)(
    "renders provider and stable sender in %s without exposing routing ids",
    (locale) => {
      const html = renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: locale },
          createElement(BotGroupSourceLabel, {
            source: {
              botId: "secret-bot-id",
              provider: "feishu",
              chatId: "secret-chat-id",
              senderId: "ou_member",
              senderName: "",
              messageId: "om_input",
            },
          }),
        ),
      );
      expect(html).toContain("ou_member");
      expect(html).toContain(locale === "zh-CN" ? "飞书" : "Feishu");
      expect(html).not.toContain("secret-chat-id");
      expect(html).not.toContain("secret-bot-id");
    },
  );
});

it("shows a short fallback instead of the raw ID as visible label", () => {
  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(BotGroupSourceLabel, {
        source: {
          provider: "feishu",
          botId: "bot",
          chatId: "chat",
          senderId: "ou_abcdef123456",
          senderName: "ou_abcdef123456",
          messageId: "m",
        },
      }),
    ),
  );
  expect(html).toContain("飞书 · 123456");
  expect(html).not.toContain("成员");
  expect(html).toContain('title="ou_abcdef123456"');
  expect(html).not.toContain("飞书 · ou_abcdef123456");
});

const historicalSource = {
  provider: "feishu" as const,
  botId: "bot",
  chatId: "chat",
  senderId: "ou_abcdef123456",
  senderName: "ou_abcdef123456",
  messageId: "m",
};
it.each(["bot", "other"])("isolates historical name overlay for %s", (botId) => {
  const html = renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        BotGroupMemberNamesContext.Provider,
        { value: { botId, chatId: "chat", names: { ou_abcdef123456: "Alice" } } },
        createElement(BotGroupSourceLabel, { source: historicalSource }),
      ),
    ),
  );
  expect(html.includes("Feishu · Alice")).toBe(botId === "bot");
  expect(historicalSource.senderName).toBe(historicalSource.senderId);
});
