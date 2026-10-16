import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedbackTicketDetail } from "@zcode/shared";
import type { IFeedbackService } from "@zcode/services";

function createTicket(id: string): FeedbackTicketDetail {
  return {
    id,
    title: "copy state",
    type: "bug",
    status: "已提交",
    created_at: "2026-06-07T04:00:00.000Z",
    updated_at: "2026-06-07T04:01:00.000Z",
    description: "desc",
    attachments: [],
    comments: [],
    events: [],
  };
}

describe("TicketDetailView issue copy state", () => {
  afterEach(() => {
    vi.doUnmock("react");
    vi.resetModules();
  });

  it("resets copied state when the ticket id changes", async () => {
    const effectDependencyLists: unknown[][] = [];

    vi.resetModules();
    vi.doMock("react", async (importOriginal) => {
      const actual = await importOriginal<typeof import("react")>();

      return {
        ...actual,
        useEffect: (
          effect: Parameters<typeof actual.useEffect>[0],
          deps?: Parameters<typeof actual.useEffect>[1],
        ) => {
          effectDependencyLists.push(deps ? [...deps] : []);
          return actual.useEffect(effect, deps);
        },
      };
    });

    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { TicketDetailView } = await import("@/feedback/TicketDetail.js");
    const { ZCodeIntlProvider } = await import("@/i18n/IntlProvider.js");

    renderToStaticMarkup(
      React.createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        React.createElement(TicketDetailView, {
          ticket: createTicket("ticket-1"),
          feedbackService: {} as IFeedbackService,
          onRefresh: vi.fn(),
          onOpenProcess: vi.fn(),
        }),
      ),
    );

    expect(effectDependencyLists).toContainEqual(["ticket-1"]);
  });
});
