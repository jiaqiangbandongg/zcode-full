import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { QueueItem } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationPendingGuideList } from "@/v4/ConversationPendingGuideList.js";

vi.mock("@/v4/ConversationTurnRow.js", async () => {
  const React = await import("react");
  return {
    ConversationTurnRow: ({
      row,
      userInputStatus,
    }: {
      row: { text: string };
      userInputStatus?: string;
    }) =>
      React.createElement(
        "article",
        null,
        row.text,
        React.createElement("small", null, userInputStatus),
      ),
  };
});

const guide: QueueItem = {
  sourceCommandId: "command-guide",
  queueItemId: "guide-1",
  clientId: "desktop",
  kind: "sendText",
  text: "请先检查这里",
  attachments: [],
  delivery: { requested: "guide", admitted: "guide" },
  order: { admissionSeq: 1, queuePosition: 0 },
  steer: { state: "steering" },
  dispatch: { state: "queued" },
  admittedAt: 100,
};

describe("ConversationPendingGuideList", () => {
  it("在消息气泡下显示等待引导提示", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationPendingGuideList, {
          context: {} as never,
          items: [guide],
          turnId: "turn-1",
        }),
      ),
    );

    expect(markup).toContain("请先检查这里");
    expect(markup).toContain("等待引导当前任务…");
  });
});
