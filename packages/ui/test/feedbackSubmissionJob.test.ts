import { describe, expect, it, vi } from "vitest";
import type { FeedbackTicketDetail, FeedbackTicketSummary } from "@zcode/shared";
import type { FeedbackUploadProgress, IFeedbackService } from "@zcode/services";
import {
  cancelFeedbackCreateSubmissionJob,
  dismissFeedbackSubmissionJob,
  getFeedbackSubmissionJob,
  getFeedbackSubmissionJobsSnapshot,
  startFeedbackSubmissionJob,
  subscribeFeedbackSubmissionJobs,
  type FeedbackSubmissionCopy,
  type StartFeedbackSubmissionJobOptions,
  type FeedbackSubmissionProgressState,
} from "@/feedback/feedbackSubmissionJob.js";
import type { FeedbackSubmitDraft } from "@/feedback/feedbackStore.js";

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
    uploadAttachmentData: vi.fn(async () => ({
      id: 1,
      kind: "image",
      filename: "screenshot.png",
      size: 128,
      content_type: "image/png",
      download_url: null,
      created_at: "2026-06-04T10:00:00.000Z",
    })),
    cancelCreate: vi.fn(async () => undefined),
    uploadAttachmentWithProgress: vi.fn(async () => ({
      id: 2,
      kind: "log",
      filename: "logs.zip",
      size: 256,
      content_type: "application/zip",
      download_url: null,
      created_at: "2026-06-04T10:00:00.000Z",
    })),
    prepareCompactLogArchive: vi.fn(async () => ({ path: "/tmp/logs.zip", size: 256 })),
    cleanupPreparedLogArchive: vi.fn(async () => undefined),
    onDynamicUploadProgress: vi.fn(() => () => ({
      dispose: vi.fn(),
    })),
    cancelUpload: vi.fn(async () => undefined),
    revealLogArchive: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as IFeedbackService;
}

function createSubmissionCopy(
  overrides: Partial<FeedbackSubmissionCopy> = {},
): FeedbackSubmissionCopy {
  return {
    connectingLabel: "connecting",
    connectingDetail: "connecting detail",
    cancelingCreateLabel: "canceling",
    cancelingCreateDetail: "canceling detail",
    canceledLabel: "canceled",
    canceledDetail: "canceled detail",
    uploadingScreenshotLabel: "uploading screenshot",
    submittedLabel: "submitted",
    submittedDetail: "submitted detail",
    failedLabel: "failed",
    networkErrorDetail: "network error",
    postCreateNetworkErrorDetail: "feedback created but additional materials failed to upload",
    pausingLogLabel: "pausing log",
    pausingLogDetail: "pausing log detail",
    exportingLogLabel: "exporting log",
    exportingLogDetail: "exporting log detail",
    uploadingLogLabel: "uploading log",
    logUploadSuccessLabel: "log uploaded",
    logUploadPausedLabel: "log paused",
    logUploadPausedDetail: "log paused detail",
    preparingUploadDetail: "preparing upload",
    ...overrides,
  };
}

function startTestFeedbackSubmissionJob(
  options: Omit<StartFeedbackSubmissionJobOptions, "formDraft"> & {
    formDraft?: FeedbackSubmitDraft;
  },
) {
  const { formDraft, ...submissionOptions } = options;
  return startFeedbackSubmissionJob({
    ...submissionOptions,
    formDraft:
      formDraft ??
      {
        description: options.ticketInput.description,
        contact: options.ticketInput.contact,
        screenshots: options.screenshots,
        includeLogs: options.includeLogs,
        type: options.ticketInput.type,
        severity: options.ticketInput.severity,
        module: options.ticketInput.module,
      },
  });
}

describe("feedback submission job", () => {
  it("shows localized guidance and preserves the submission draft after retries are exhausted", async () => {
    const feedbackService = createFeedbackService({
      create: vi.fn(async () => {
        // services 已完成三次建连重试，UI 边界只会收到最终的顶层错误。
        throw new Error("fetch failed");
      }),
    });
    const ticketInput = {
      title: "连接失败",
      description: "用户现场描述",
      type: "bug" as const,
      source: "desktop-app",
      contact: "user@example.com",
    };
    const screenshots = [
      {
        filename: "现场.png",
        contentType: "image/png",
        dataBase64: "ZmFrZQ==",
        size: 4,
      },
    ];
    const job = startTestFeedbackSubmissionJob({
      feedbackService,
      ticketInput,
      screenshots,
      includeLogs: false,
      copy: createSubmissionCopy({
        networkErrorDetail: "Check your network, VPN, or proxy settings, then try again.",
      }),
    });

    await expect(job.done).rejects.toThrow("fetch failed");
    expect(job.getState()).toMatchObject({
      status: "error",
      error: "Check your network, VPN, or proxy settings, then try again.",
      progress: {
        label: "failed",
        detail: "Check your network, VPN, or proxy settings, then try again.",
      },
    });
    expect(feedbackService.create).toHaveBeenCalledWith(ticketInput, expect.any(Object));
    expect(ticketInput).toMatchObject({
      description: "用户现场描述",
      contact: "user@example.com",
    });
    expect(screenshots).toEqual([
      expect.objectContaining({ filename: "现场.png", dataBase64: "ZmFrZQ==" }),
    ]);
    expect(job.formDraft).toMatchObject({
      description: "用户现场描述",
      contact: "user@example.com",
      screenshots: [expect.objectContaining({ filename: "现场.png" })],
    });
    expect(Object.isFrozen(job.formDraft)).toBe(true);
    expect(Object.isFrozen(job.formDraft.screenshots)).toBe(true);
    expect(Object.isFrozen(job.formDraft.screenshots?.[0])).toBe(true);
    expect(feedbackService.uploadAttachmentData).not.toHaveBeenCalled();
    dismissFeedbackSubmissionJob(job.id);
  });

  it("does not ask users to resubmit after the ticket was created", async () => {
    const feedbackService = createFeedbackService({
      uploadAttachmentWithProgress: vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    });
    const job = startTestFeedbackSubmissionJob({
      feedbackService,
      ticketInput: {
        title: "日志上传失败",
        description: "工单已经创建",
        type: "bug",
        source: "desktop-app",
      },
      screenshots: [],
      includeLogs: true,
      copy: createSubmissionCopy({
        networkErrorDetail: "Check your network and resubmit.",
        postCreateNetworkErrorDetail:
          "Feedback was created, but additional materials failed to upload.",
      }),
    });

    await expect(job.done).rejects.toThrow("fetch failed");
    expect(job.getState()).toMatchObject({
      status: "error",
      ticketId: "ticket-1",
      error: "Feedback was created, but additional materials failed to upload.",
      progress: {
        detail: "Feedback was created, but additional materials failed to upload.",
      },
    });
    expect(feedbackService.create).toHaveBeenCalledTimes(1);
    expect(getFeedbackSubmissionJob(job.id)).toBe(job);
    dismissFeedbackSubmissionJob(job.id);
  });

  it("continues uploading after the foreground subscriber is disposed", async () => {
    const feedbackService = createFeedbackService();
    const seen: FeedbackSubmissionProgressState[] = [];

    const job = startTestFeedbackSubmissionJob({
      feedbackService,
      ticketInput: {
        title: "后台上传反馈",
        description: "desc",
        type: "bug",
        source: "desktop-app",
      },
      screenshots: [
        {
          filename: "screenshot.png",
          contentType: "image/png",
          dataBase64: "ZmFrZQ==",
          size: 128,
        },
      ],
      includeLogs: true,
    });
    const subscription = job.subscribe((state) => {
      seen.push(state.progress);
    });

    subscription.dispose();
    await expect(job.done).resolves.toEqual({ ticketId: "ticket-1" });

    expect(feedbackService.create).toHaveBeenCalledTimes(1);
    expect(feedbackService.uploadAttachmentData).toHaveBeenCalledTimes(1);
    expect(feedbackService.uploadAttachmentWithProgress).toHaveBeenCalledTimes(1);
    expect(feedbackService.cleanupPreparedLogArchive).toHaveBeenCalledWith("/tmp/logs.zip");
    expect(seen.some((progress) => progress.label === "正在连接反馈服务")).toBe(true);
    expect(job.getState()).toMatchObject({
      status: "success",
      ticketId: "ticket-1",
      progress: { label: "反馈已提交" },
    });
  });

  it("notifies after ticket creation before background attachments finish uploading", async () => {
    let finishScreenshotUpload: (() => void) | null = null;
    const onTicketCreated = vi.fn();
    const feedbackService = createFeedbackService({
      uploadAttachmentData: vi.fn(
        () =>
          new Promise((resolve) => {
            finishScreenshotUpload = () =>
              resolve({
                id: 1,
                kind: "image",
                filename: "screenshot.png",
                size: 128,
                content_type: "image/png",
                download_url: null,
                created_at: "2026-06-04T10:00:00.000Z",
              });
          }),
      ),
    });

    const job = startTestFeedbackSubmissionJob({
      feedbackService,
      ticketInput: {
        title: "后台上传反馈",
        description: "desc",
        type: "bug",
        source: "desktop-app",
      },
      screenshots: [
        {
          filename: "screenshot.png",
          contentType: "image/png",
          dataBase64: "ZmFrZQ==",
          size: 128,
        },
      ],
      includeLogs: false,
      onTicketCreated,
    });

    await vi.waitFor(() => {
      expect(onTicketCreated).toHaveBeenCalledWith("ticket-1");
    });

    expect(job.getState().ticketId).toBe("ticket-1");
    expect(feedbackService.uploadAttachmentData).toHaveBeenCalledTimes(1);
    expect(job.getState().status).toBe("running");

    finishScreenshotUpload?.();
    await expect(job.done).resolves.toEqual({ ticketId: "ticket-1" });
  });

  it("keeps running jobs visible through the global subscription after foreground disposal", async () => {
    let releaseCreate: (() => void) | null = null;
    const feedbackService = createFeedbackService({
      create: vi.fn(
        () =>
          new Promise<FeedbackTicketDetail>((resolve) => {
            releaseCreate = () => resolve(createTicket("ticket-global"));
          }),
      ),
    });
    const snapshots: string[][] = [];
    const subscription = subscribeFeedbackSubmissionJobs((jobs) => {
      snapshots.push(jobs.map((job) => job.id));
    });

    const job = startTestFeedbackSubmissionJob({
      feedbackService,
      ticketInput: {
        title: "后台上传反馈",
        description: "desc",
        type: "bug",
        source: "desktop-app",
      },
      screenshots: [],
      includeLogs: false,
    });
    const foreground = job.subscribe(() => undefined);
    foreground.dispose();

    expect(getFeedbackSubmissionJobsSnapshot().map((item) => item.id)).toContain(job.id);
    expect(snapshots.some((ids) => ids.includes(job.id))).toBe(true);

    releaseCreate?.();
    await expect(job.done).resolves.toEqual({ ticketId: "ticket-global" });
    expect(feedbackService.prepareCompactLogArchive).not.toHaveBeenCalled();
    expect(feedbackService.uploadAttachmentWithProgress).not.toHaveBeenCalled();
    expect(feedbackService.cleanupPreparedLogArchive).not.toHaveBeenCalled();
    subscription.dispose();
  });

  it("continues required log upload after the running upload is canceled", async () => {
    let attempt = 0;
    const feedbackService = createFeedbackService({
      uploadAttachmentWithProgress: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          const error = new Error("Feedback upload canceled");
          error.name = "FeedbackUploadCanceledError";
          throw error;
        }
      }),
    });

    const job = startTestFeedbackSubmissionJob({
      feedbackService,
      ticketInput: {
        title: "后台上传反馈",
        description: "desc",
        type: "bug",
        source: "desktop-app",
      },
      screenshots: [],
      includeLogs: true,
    });

    await vi.waitFor(() => {
      expect(job.getState().status).toBe("paused-log");
    });
    job.continueLogUpload();

    await expect(job.done).resolves.toEqual({ ticketId: "ticket-1" });
    expect(feedbackService.comment).not.toHaveBeenCalledWith(
      "ticket-1",
      expect.stringContaining("用户选择不上传完整日志"),
    );
    expect(feedbackService.uploadAttachmentWithProgress).toHaveBeenCalledTimes(2);
    expect(job.getState().status).toBe("success");
  });

  it("keeps paused required log uploads visible when the background indicator is dismissed", async () => {
    let attempt = 0;
    const feedbackService = createFeedbackService({
      uploadAttachmentWithProgress: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) {
          const error = new Error("Feedback upload canceled");
          error.name = "FeedbackUploadCanceledError";
          throw error;
        }
      }),
    });

    const job = startTestFeedbackSubmissionJob({
      feedbackService,
      ticketInput: {
        title: "后台上传反馈",
        description: "desc",
        type: "bug",
        source: "desktop-app",
      },
      screenshots: [],
      includeLogs: true,
    });

    await vi.waitFor(() => {
      expect(job.getState().status).toBe("paused-log");
    });

    dismissFeedbackSubmissionJob(job.id);

    expect(getFeedbackSubmissionJobsSnapshot().map((item) => item.id)).toContain(job.id);

    job.continueLogUpload();
    await expect(job.done).resolves.toEqual({ ticketId: "ticket-1" });
    dismissFeedbackSubmissionJob(job.id);
  });

  it("does not mark the submission successful when automatic log upload fails", async () => {
    const feedbackService = createFeedbackService({
      uploadAttachmentWithProgress: vi.fn(async () => {
        throw new Error("network dropped before logs completed");
      }),
    });

    const job = startTestFeedbackSubmissionJob({
      feedbackService,
      ticketInput: {
        title: "后台上传反馈",
        description: "desc",
        type: "bug",
        source: "desktop-app",
      },
      screenshots: [],
      includeLogs: true,
    });

    await expect(job.done).rejects.toThrow("network dropped before logs completed");
    expect(feedbackService.comment).toHaveBeenCalledWith(
      "ticket-1",
      expect.stringContaining("完整日志自动上传失败"),
    );
    expect(job.getState()).toMatchObject({
      status: "error",
      ticketId: "ticket-1",
      progress: {
        label: "反馈提交失败",
        detail: "network dropped before logs completed",
      },
    });
  });

  it("does not downgrade to compact logs when the full archive is rejected as too large", async () => {
    const uploadAttachmentWithProgress = vi
      .fn()
      .mockRejectedValueOnce(new Error("Upload failed: HTTP 413"));
    const feedbackService = createFeedbackService({
      prepareCompactLogArchive: vi
        .fn()
        .mockResolvedValueOnce({ path: "/tmp/full-logs.zip", size: 60 * 1024 * 1024 }),
      uploadAttachmentWithProgress,
    });

    const job = startTestFeedbackSubmissionJob({
      feedbackService,
      ticketInput: {
        title: "后台上传反馈",
        description: "desc",
        type: "bug",
        source: "desktop-app",
      },
      screenshots: [],
      includeLogs: true,
    });

    await expect(job.done).rejects.toThrow("Upload failed: HTTP 413");
    expect(feedbackService.prepareCompactLogArchive).toHaveBeenNthCalledWith(1, {
      full: true,
      progressId: expect.any(String),
    });
    expect(feedbackService.prepareCompactLogArchive).toHaveBeenCalledTimes(1);
    expect(uploadAttachmentWithProgress).toHaveBeenCalledTimes(1);
    expect(feedbackService.cleanupPreparedLogArchive).toHaveBeenCalledWith("/tmp/full-logs.zip");
    expect(feedbackService.cleanupPreparedLogArchive).toHaveBeenCalledTimes(1);
    expect(job.getState()).toMatchObject({
      status: "error",
      ticketId: "ticket-1",
      progress: {
        label: "反馈提交失败",
        detail: "Upload failed: HTTP 413",
      },
    });
  });

  it("shows determinate progress while exporting the full log archive", async () => {
    let emitProgress: ((progress: FeedbackUploadProgress) => void) | null = null;
    let resolveArchive: (() => void) | null = null;
    const feedbackService = createFeedbackService({
      onDynamicUploadProgress: vi.fn(() => (listener) => {
        emitProgress = listener;
        return { dispose: vi.fn() };
      }),
      prepareCompactLogArchive: vi.fn(
        () =>
          new Promise<{ path: string; size: number }>((resolve) => {
            resolveArchive = () => resolve({ path: "/tmp/full-logs.zip", size: 200 });
          }),
      ),
    });

    const job = startTestFeedbackSubmissionJob({
      feedbackService,
      ticketInput: {
        title: "后台上传反馈",
        description: "desc",
        type: "bug",
        source: "desktop-app",
      },
      screenshots: [],
      includeLogs: true,
    });

    await vi.waitFor(() => {
      expect(feedbackService.prepareCompactLogArchive).toHaveBeenCalled();
    });
    emitProgress?.({
      id: "feedback-log-ticket-1-export",
      phase: "preparing",
      uploadedBytes: 80,
      totalBytes: 200,
    });

    expect(job.getState().progress).toMatchObject({
      kind: "working",
      label: "正在导出完整日志",
      detail: "80 B / 200 B",
      progress: 40,
      uploadedBytes: 80,
      totalBytes: 200,
    });

    resolveArchive?.();
    await expect(job.done).resolves.toEqual({ ticketId: "ticket-1" });
  });

  it("cancels hanging ticket creation before screenshot and log upload start", async () => {
    let rejectCreate: ((error: Error) => void) | null = null;
    let createOperationId = "";
    const feedbackService = createFeedbackService({
      create: vi.fn(
        (_input, options) =>
          new Promise<FeedbackTicketDetail>((_resolve, reject) => {
            createOperationId = options?.operationId ?? "";
            rejectCreate = reject;
          }),
      ),
      cancelCreate: vi.fn(async (operationId: string) => {
        expect(operationId).toBe(createOperationId);
        rejectCreate?.(new Error("The operation was aborted."));
      }),
    });

    const job = startTestFeedbackSubmissionJob({
      feedbackService,
      ticketInput: {
        title: "后台上传反馈",
        description: "desc",
        type: "bug",
        source: "desktop-app",
      },
      screenshots: [
        {
          filename: "screenshot.png",
          contentType: "image/png",
          dataBase64: "ZmFrZQ==",
          size: 128,
        },
      ],
      includeLogs: true,
    });

    await vi.waitFor(() => {
      expect(createOperationId).toMatch(/^feedback-create-/);
    });

    await job.cancelSubmission();

    await expect(job.done).rejects.toThrow("反馈提交已取消");
    expect(feedbackService.cancelCreate).toHaveBeenCalledWith(createOperationId);
    expect(feedbackService.uploadAttachmentData).not.toHaveBeenCalled();
    expect(feedbackService.prepareCompactLogArchive).not.toHaveBeenCalled();
    expect(job.getState()).toMatchObject({
      status: "error",
      error: "反馈提交已取消",
      progress: {
        label: "反馈提交已取消",
      },
    });
  });

  it("keeps submission canceled when ticket creation returns after cancel", async () => {
    let resolveCreate: (() => void) | null = null;
    let createOperationId = "";
    const feedbackService = createFeedbackService({
      create: vi.fn(
        (_input, options) =>
          new Promise<FeedbackTicketDetail>((resolve) => {
            createOperationId = options?.operationId ?? "";
            resolveCreate = () => resolve(createTicket("ticket-after-cancel"));
          }),
      ),
      cancelCreate: vi.fn(async (operationId: string) => {
        expect(operationId).toBe(createOperationId);
      }),
    });

    const job = startTestFeedbackSubmissionJob({
      feedbackService,
      ticketInput: {
        title: "后台上传反馈",
        description: "desc",
        type: "bug",
        source: "desktop-app",
      },
      screenshots: [
        {
          filename: "screenshot.png",
          contentType: "image/png",
          dataBase64: "ZmFrZQ==",
          size: 128,
        },
      ],
      includeLogs: false,
    });

    await vi.waitFor(() => {
      expect(createOperationId).toMatch(/^feedback-create-/);
    });

    await job.cancelSubmission();
    resolveCreate?.();

    await expect(job.done).rejects.toThrow("反馈提交已取消");
    expect(feedbackService.cancelCreate).toHaveBeenCalledWith(createOperationId);
    expect(feedbackService.uploadAttachmentData).not.toHaveBeenCalled();
    expect(feedbackService.prepareCompactLogArchive).not.toHaveBeenCalled();
    expect(job.getState()).toMatchObject({
      status: "error",
      error: "反馈提交已取消",
      progress: {
        label: "反馈提交已取消",
      },
    });
  });

  it("keeps the job visible when the create cancel command fails", async () => {
    let resolveCreate: (() => void) | null = null;
    let createOperationId = "";
    const onCancelError = vi.fn();
    const feedbackService = createFeedbackService({
      create: vi.fn(
        (_input, options) =>
          new Promise<FeedbackTicketDetail>((resolve) => {
            createOperationId = options?.operationId ?? "";
            resolveCreate = () => resolve(createTicket("ticket-cancel-command-failed"));
          }),
      ),
      cancelCreate: vi.fn(async () => {
        throw new Error("cancel command failed");
      }),
    });

    const job = startTestFeedbackSubmissionJob({
      feedbackService,
      ticketInput: {
        title: "后台上传反馈",
        description: "desc",
        type: "bug",
        source: "desktop-app",
      },
      screenshots: [],
      includeLogs: false,
    });

    await vi.waitFor(() => {
      expect(createOperationId).toMatch(/^feedback-create-/);
    });

    await expect(cancelFeedbackCreateSubmissionJob(job, { onCancelError })).resolves.toBe(false);

    expect(feedbackService.cancelCreate).toHaveBeenCalledWith(createOperationId);
    expect(onCancelError).toHaveBeenCalledWith("cancel command failed");
    expect(getFeedbackSubmissionJobsSnapshot().map((item) => item.id)).toContain(job.id);
    expect(job.getState()).toMatchObject({
      status: "running",
      progress: {
        label: "正在连接反馈服务",
      },
    });

    resolveCreate?.();
    await expect(job.done).rejects.toThrow("反馈提交已取消");
    dismissFeedbackSubmissionJob(job.id);
  });
});
