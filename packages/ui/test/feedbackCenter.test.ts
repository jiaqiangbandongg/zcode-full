import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { IFeedbackService } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";

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

describe("FeedbackCenter", () => {
  it("does not import a background ticket list watcher", () => {
    const source = readFileSync(
      new URL("../src/feedback/FeedbackCenter.tsx", import.meta.url),
      "utf-8",
    );

    expect(source).not.toContain("FeedbackUpdateWatcher");
  });

  it("does not mount a background ticket list watcher", async () => {
    const feedbackService = createFeedbackService();
    const { FeedbackCenter } = await import("@/feedback/FeedbackCenter.js");

    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          TabStoreProvider,
          null,
          createElement(FeedbackCenter, {
            feedbackService,
            platform: { showTaskNotification: vi.fn() } as unknown as IPlatformService,
          }),
        ),
      ),
    );

    expect(feedbackService.list).not.toHaveBeenCalled();
  });

  it("defines a tickets-only header back button that returns to submit feedback", () => {
    const source = readFileSync(
      new URL("../src/feedback/FeedbackCenter.tsx", import.meta.url),
      "utf-8",
    );

    expect(source).toContain("ArrowLeftIcon");
    expect(source).toContain('tab === "tickets"');
    expect(source).toContain('data-feedback-back-to-submit="true"');
    expect(source).toContain("feedback.center.backToSubmit");
    expect(source).toContain('setTab("submit")');
  });

  it("hides the background upload indicator while any feedback dialog is open", () => {
    const source = readFileSync(
      new URL("../src/feedback/FeedbackCenter.tsx", import.meta.url),
      "utf-8",
    );

    expect(source).toContain("featureRequestOpen");
    expect(source).toContain(
      "<FeedbackBackgroundUploadIndicator feedbackDialogOpen={open || featureRequestOpen} />",
    );
  });

  it("defines localized copy for the feedback tickets back button", () => {
    const zh = readFileSync(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url), "utf-8");
    const en = readFileSync(new URL("../src/i18n/locales/en-US.ts", import.meta.url), "utf-8");

    expect(zh).toContain('"feedback.center.backToSubmit": "返回提交反馈"');
    expect(en).toContain('"feedback.center.backToSubmit": "Back to submit feedback"');
  });
});
