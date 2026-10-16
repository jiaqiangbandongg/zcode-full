import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FeedbackTicketDetail, FeedbackTicketSummary } from "@zcode/shared";
import type { IFeedbackService } from "@zcode/services";
import {
  FeedbackBackgroundUploadIndicator,
  FeedbackBackgroundUploadIndicatorView,
  getFeedbackBackgroundOpenTarget,
  shouldOpenExistingFeedbackTicket,
  type FeedbackBackgroundUploadIndicatorViewProps,
} from "@/feedback/FeedbackBackgroundUploadIndicator.js";
import {
  dismissFeedbackSubmissionJob,
  startFeedbackSubmissionJob,
} from "@/feedback/feedbackSubmissionJob.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

function createTicket(id: string): FeedbackTicketDetail {
  const summary: FeedbackTicketSummary = {
    id,
    title: "后台上传反馈",
    type: "bug",
    status: "已提交",
    created_at: "2026-06-04T10:00:00.000Z",
    updated_at: "2026-06-04T10:00:00.000Z",
  };
  return {
    ...summary,
    description: "desc",
    attachments: [],
    comments: [],
    events: [],
  };
}

function createFeedbackService(overrides: Partial<IFeedbackService> = {}): IFeedbackService {
  return {
    getDeviceSnapshot: vi.fn(),
    create: vi.fn(async () => createTicket("ticket-1")),
    list: vi.fn(),
    get: vi.fn(),
    comment: vi.fn(async () => ({
      id: 1,
      body: "ok",
      created_at: "2026-06-04T10:00:00.000Z",
    })),
    uploadAttachmentData: vi.fn(),
    uploadAttachmentWithProgress: vi.fn(),
    prepareCompactLogArchive: vi.fn(),
    cleanupPreparedLogArchive: vi.fn(),
    onDynamicUploadProgress: vi.fn(() => () => ({
      dispose: vi.fn(),
    })),
    cancelCreate: vi.fn(),
    cancelUpload: vi.fn(),
    revealLogArchive: vi.fn(),
    ...overrides,
  } as unknown as IFeedbackService;
}

function renderIndicator(props?: Partial<FeedbackBackgroundUploadIndicatorViewProps>) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(FeedbackBackgroundUploadIndicatorView, {
        status: "running",
        progress: {
          kind: "uploading-log",
          label: "正在上传完整日志",
          detail: "2.0 MB / 4.0 MB",
          progress: 50,
        },
        onOpen: vi.fn(),
        onContinueUpload: vi.fn(),
        onDismiss: vi.fn(),
        defaultExpanded: false,
        ...props,
      }),
    ),
  );
}

describe("FeedbackBackgroundUploadIndicator", () => {
  it("opens an existing ticket for terminal background jobs", () => {
    expect(shouldOpenExistingFeedbackTicket("success", "ticket-1")).toBe(true);
    expect(shouldOpenExistingFeedbackTicket("error", "ticket-1")).toBe(true);
    expect(shouldOpenExistingFeedbackTicket("error", undefined)).toBe(false);
    expect(shouldOpenExistingFeedbackTicket("paused-log", "ticket-1")).toBe(false);
  });

  it("targets the exact unfinished submission card that was clicked", () => {
    expect(
      getFeedbackBackgroundOpenTarget({
        id: "feedback-job-a",
        status: "running",
        ticketId: "ticket-a",
      }),
    ).toEqual({ kind: "submission", jobId: "feedback-job-a" });
    expect(
      getFeedbackBackgroundOpenTarget({
        id: "feedback-job-b",
        status: "paused-log",
        ticketId: "ticket-b",
      }),
    ).toEqual({ kind: "submission", jobId: "feedback-job-b" });
    expect(
      getFeedbackBackgroundOpenTarget({
        id: "feedback-job-c",
        status: "error",
        ticketId: "ticket-c",
      }),
    ).toEqual({ kind: "ticket", ticketId: "ticket-c" });
  });

  it("stays hidden while the feedback submit dialog is still open", async () => {
    let releaseCreate: (() => void) | null = null;
    const feedbackService = createFeedbackService({
      create: vi.fn(
        () =>
          new Promise<FeedbackTicketDetail>((resolve) => {
            releaseCreate = () => resolve(createTicket("ticket-open"));
          }),
      ),
    });
    const job = startFeedbackSubmissionJob({
      feedbackService,
      ticketInput: {
        title: "后台上传反馈",
        description: "desc",
        type: "bug",
        source: "desktop-app",
      },
      screenshots: [],
      includeLogs: false,
      formDraft: {
        description: "desc",
        screenshots: [],
        includeLogs: false,
        type: "bug",
      },
    });

    expect(
      renderToStaticMarkup(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(FeedbackBackgroundUploadIndicator, {
            feedbackDialogOpen: true,
          }),
        ),
      ),
    ).toBe("");

    releaseCreate?.();
    await job.done.finally(() => dismissFeedbackSubmissionJob(job.id));
  });

  it("renders one card for every unfinished background submission", () => {
    const feedbackService = createFeedbackService({
      create: vi.fn(() => new Promise<FeedbackTicketDetail>(() => {})),
    });
    const jobs = ["并发反馈 A", "并发反馈 B"].map((title) =>
      startFeedbackSubmissionJob({
        feedbackService,
        ticketInput: {
          title,
          description: title,
          type: "bug",
          source: "desktop-app",
        },
        screenshots: [],
        includeLogs: false,
        formDraft: {
          description: title,
          screenshots: [],
          includeLogs: false,
          type: "bug",
        },
      }),
    );

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(FeedbackBackgroundUploadIndicator, {
          feedbackDialogOpen: false,
        }),
      ),
    );

    expect(html.match(/正在提交反馈/g)).toHaveLength(2);
    expect(html).toContain("flex-col");
    for (const job of jobs) {
      dismissFeedbackSubmissionJob(job.id);
    }
  });

  it("renders a folded status capsule by default to avoid covering the workspace", () => {
    const html = renderIndicator();

    expect(html).toContain("正在提交反馈");
    expect(html).toContain("rounded-xl border border-popover-border bg-popover");
    expect(html).toContain("grid-cols-[auto_minmax(0,1fr)_auto]");
    expect(html).toContain("gap-0.5");
    expect(html).not.toContain("rounded-md border border-border bg-surface");
    expect(html).toContain("正在上传完整日志");
    expect(html).toContain("50%");
    expect(html).toContain("打开反馈提交详情");
    expect(html).not.toContain("展开反馈提交状态");
    expect(html).not.toContain("2.0 MB / 4.0 MB");
    expect(html).not.toContain("暂停日志");
  });

  it("keeps the success state folded with progress visible", () => {
    const html = renderIndicator({
      status: "success",
      progress: {
        kind: "success",
        label: "反馈已提交",
        detail: "我们会尽快处理。",
        progress: 100,
      },
    });

    expect(html).toContain("反馈已提交");
    expect(html).toContain("100%");
    expect(html).toContain("width:100%");
    expect(html).toContain("打开反馈提交详情");
    expect(html).not.toContain("展开反馈提交状态");
    expect(html).not.toContain("我们会尽快处理。");
  });

  it("renders full progress details without log skip actions when expanded", () => {
    const html = renderIndicator({ defaultExpanded: true });

    expect(html).toContain("正在提交反馈");
    expect(html).toContain("rounded-xl border border-popover-border bg-popover");
    expect(html).toContain("grid-cols-[auto_minmax(0,1fr)_auto]");
    expect(html).toContain("gap-0.5");
    expect(html).not.toContain("rounded-md border border-border bg-surface");
    expect(html).toContain("正在上传完整日志");
    expect(html).toContain("2.0 MB / 4.0 MB");
    expect(html).toContain("width:50%");
    expect(html).toContain("点击查看详情");
    expect(html).toContain("打开反馈提交详情");
    expect(html).not.toContain("暂停日志");
    expect(html).not.toContain("不传日志");
  });

  it("only allows continuing when log upload is paused", () => {
    const html = renderIndicator({
      defaultExpanded: true,
      status: "paused-log",
      progress: {
        kind: "paused-log",
        label: "已暂停日志上传",
        detail: "日志是定位问题的必需材料，请继续上传。",
        progress: 0,
      },
    });

    expect(html).toContain("已暂停日志上传");
    expect(html).toContain("继续上传");
    expect(html).not.toContain("隐藏反馈提交状态");
    expect(html).not.toContain("不传日志");
  });
});
