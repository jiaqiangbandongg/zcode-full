import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { IFeedbackService } from "@zcode/services";
import type { FeedbackTicketSummary } from "@zcode/shared";
import {
  FeedbackTicketList,
  TicketsInitialLoadingState,
  TicketsView,
} from "@/feedback/TicketsView.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

function createFeedbackService(): IFeedbackService {
  return {
    getDeviceSnapshot: vi.fn(),
    create: vi.fn(),
    list: vi.fn(async () => ({ items: [], total: 0 })),
    get: vi.fn(),
    comment: vi.fn(),
    uploadAttachmentData: vi.fn(),
    uploadAttachmentWithProgress: vi.fn(),
    prepareCompactLogArchive: vi.fn(),
    cleanupPreparedLogArchive: vi.fn(),
    onDynamicUploadProgress: vi.fn(),
    cancelCreate: vi.fn(),
    cancelUpload: vi.fn(),
    onDynamicUpdate: vi.fn(),
  } as unknown as IFeedbackService;
}

function renderTicketsView(locale: "zh-CN" | "en-US") {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(TicketsView, {
        feedbackService: createFeedbackService(),
        onCreateNew: vi.fn(),
      }),
    ),
  );
}

describe("TicketsView", () => {
  it("uses English copy for the initial feedback list loading state without a detail placeholder", () => {
    const html = renderTicketsView("en-US");

    expect(html).toContain("Loading...");
    expect(html).not.toContain("Select feedback to view details");
    expect(html).not.toContain("加载中");
  });

  it("renders ticket IDs with a copy action in the list", () => {
    const ticket: FeedbackTicketSummary = {
      id: "ZC-123",
      title: "Cannot submit prompt",
      type: "bug",
      status: "已提交",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(FeedbackTicketList, {
          items: [ticket],
          selectedTicketId: null,
          copiedTicketId: null,
          onCopyTicketId: vi.fn(),
        }),
      ),
    );

    expect(html).toContain("ZC-123");
    expect(html).toContain("Issue #");
    expect(html).toContain("Copy issue ID");
    expect(html).toContain("Cannot submit prompt");
  });

  it("renders the initial ticket list loading state centered in the content area", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(TicketsInitialLoadingState),
      ),
    );

    expect(html).toContain("加载中...");
    expect(html).toContain("flex-1");
    expect(html).toContain("items-center");
    expect(html).toContain("justify-center");
  });
});
