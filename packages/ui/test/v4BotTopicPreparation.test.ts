import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { BotTopicPreparationList as PreparationList } from "@/v4/BotTopicPreparation.js";

const BotTopicPreparationList = (props: Parameters<typeof PreparationList>[0]) =>
  createElement(
    TooltipProvider,
    null,
    createElement(PreparationList, { provider: "feishu", ...props }),
  );

describe("topic preparation presentation", () => {
  it("shows active preparation but omits failed rows entirely", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN", children: null },
        createElement(BotTopicPreparationList, {
          items: [
            { messageId: "a", senderName: "Alice", text: "first", status: "preparing" },
            { messageId: "b", senderName: "Bob", text: "second", status: "waitingStop" },
            {
              messageId: "c",
              senderName: "Carol",
              text: "third",
              status: "failed",
              error: "download failed",
            },
          ],
        }),
      ),
    );
    expect(html).toContain("Alice");
    expect(html).toContain("Bob");
    expect(html).toContain("正在准备材料");
    expect(html).toContain("等待当前执行停止");
    expect(html).not.toContain("download failed");
    expect(html).not.toContain("Carol");
    expect(html).not.toContain("材料准备失败");
    expect(html).not.toContain("重试");
    expect(html.match(/data-topic-preparation-loading="true"/g)).toHaveLength(2);
  });
  it("shows channel and loading in the source row, keeping an empty input bubble absent", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN", children: null },
        createElement(BotTopicPreparationList, {
          items: [
            { messageId: "a", senderName: "Alice", text: "first\nsecond", status: "preparing" },
            { messageId: "b", senderName: "Bob", text: "  ", status: "waitingStop" },
          ],
        }),
      ),
    );
    expect(html.match(/data-v4-user-input-bubble="true"/g)).toHaveLength(1);
    expect(html.match(/data-v4-user-input-collapsible-content="true"/g)).toHaveLength(1);
    expect(html).toContain("飞书 · Alice");
    expect(html).toContain('data-topic-preparation-loading="true"');
    expect(html).not.toContain("Alice ·");
    expect(html).toContain('data-v4-user-input-collapsible-content="true"');
    expect(html.indexOf("Alice")).toBeLessThan(html.indexOf("data-v4-user-input-bubble"));
    expect(html).not.toContain(">正在准备材料<");
  });

  it("hides late preparation only for original message IDs already in formal rows", () => {
    const acceptedRows = [
      {
        kind: "userInput",
        botGroupSource: {
          messageId: "b",
          messages: [{ messageId: "a" }, { messageId: "b" }],
        },
      },
    ] as UserInputRow[];
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US", children: null },
        createElement(BotTopicPreparationList, {
          items: ["a", "b", "c"].map((messageId) => ({
            messageId,
            senderName: messageId,
            text: "same text",
            status: "preparing" as const,
          })),
          acceptedRows,
        }),
      ),
    );
    expect(html).not.toContain('data-topic-preparation="a"');
    expect(html).not.toContain('data-topic-preparation="b"');
    expect(html).toContain('data-topic-preparation="c"');
  });
  it("keeps the Lark channel name", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN", children: null },
        createElement(BotTopicPreparationList, {
          provider: "lark",
          items: [{ messageId: "a", senderName: "Alice", text: "hello", status: "preparing" }],
        }),
      ),
    );
    expect(html).toContain("Lark · Alice");
    expect(html).not.toContain("飞书");
  });
});
