import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FeedbackTimeline } from "@/feedback/feedbackTimeline.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { FeedbackTicketEvent } from "@zcode/shared";

function renderTimeline(events: FeedbackTicketEvent[], locale: "zh-CN" | "en-US" = "en-US") {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(FeedbackTimeline, {
        events,
        comments: [],
        showDurations: true,
      }),
    ),
  );
}

describe("FeedbackTimeline", () => {
  it("localizes known backend event summaries when the app locale is English", () => {
    const html = renderTimeline([
      {
        id: 1,
        ticket_id: 1,
        type: "created",
        summary: "反馈已提交",
        payload: {},
        created_at: "2026-06-07T04:00:00.000Z",
      },
      {
        id: 2,
        ticket_id: 1,
        type: "user_replied",
        summary: "你补充了信息",
        payload: {},
        created_at: "2026-06-07T04:00:30.000Z",
      },
      {
        id: 3,
        ticket_id: 1,
        type: "status_changed",
        summary: "状态更新为「开发中」",
        payload: { to: "开发中" },
        created_at: "2026-06-07T04:01:00.000Z",
      },
      {
        id: 4,
        ticket_id: 1,
        type: "status_changed",
        summary: "进度更新（状态→已解决）：修复完成，等待验证",
        payload: { to: "已解决" },
        created_at: "2026-06-07T04:02:00.000Z",
      },
    ]);

    expect(html).toContain("Feedback submitted");
    expect(html).toContain("You added information");
    expect(html).toContain("Status changed to In development");
    expect(html).toContain("Progress updated (status to Resolved): 修复完成，等待验证");
    expect(html).not.toContain("反馈已提交");
    expect(html).not.toContain("你补充了信息");
    expect(html).not.toContain("状态更新为");
    expect(html).not.toContain("进度更新");
  });
});
