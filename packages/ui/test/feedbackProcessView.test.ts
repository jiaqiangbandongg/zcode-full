import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FeedbackTicketDetail } from "@zcode/shared";
import type { IFeedbackService } from "@zcode/services";

import { FeedbackProcessView } from "@/feedback/FeedbackProcessView.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

function createTicket(): FeedbackTicketDetail {
  return {
    id: "ticket-1",
    title: "123",
    type: "bug",
    status: "已提交",
    created_at: "2026-06-07T04:00:00.000Z",
    updated_at: "2026-06-07T04:01:00.000Z",
    description: "desc",
    attachments: [],
    comments: [],
    events: [
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
        created_at: "2026-06-07T04:01:00.000Z",
      },
    ],
  };
}

describe("FeedbackProcessView", () => {
  it("localizes the latest summary in the process header", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(FeedbackProcessView, {
          ticket: createTicket(),
          feedbackService: {} as IFeedbackService,
          onBack: vi.fn(),
          onRefresh: vi.fn(),
        }),
      ),
    );

    expect(html).toContain("Latest:");
    expect(html).toContain("You added information");
    expect(html).not.toContain("你补充了信息");
  });
});
