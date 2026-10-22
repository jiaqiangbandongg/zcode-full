import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  FeedbackSubmitForm,
  readCurrentAgentModelContext,
  shouldAutoCloseFeedbackOnTicketCreated,
} from "@/feedback/FeedbackSubmitForm.js";
import { startSimplifiedFeedbackSubmission } from "@/feedback/feedbackSubmitSubmission.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { IFeedbackService } from "@zcode/services";
import type { FeedbackTicketDetail, FeedbackTicketSummary, IPlatformService } from "@zcode/shared";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { dismissFeedbackSubmissionJob } from "@/feedback/feedbackSubmissionJob.js";

function createFeedbackService(): IFeedbackService {
  return {
    getDeviceSnapshot: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
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

function createTicket(id: string): FeedbackTicketDetail {
  const summary: FeedbackTicketSummary = {
    id,
    title: "功能建议",
    type: "feature",
    status: "已提交",
    created_at: "2026-06-17T10:00:00.000Z",
    updated_at: "2026-06-17T10:00:00.000Z",
  };
  return {
    ...summary,
    description: "desc",
    attachments: [],
    comments: [],
    events: [],
  };
}

function renderFeedbackSubmitForm(locale: "zh-CN" | "en-US" = "zh-CN") {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(
        TabStoreProvider,
        null,
        createElement(FeedbackSubmitForm, {
          feedbackService: createFeedbackService(),
          platform: {} as IPlatformService,
          onSubmitted: vi.fn(),
          onViewTickets: vi.fn(),
          onCancel: vi.fn(),
        }),
      ),
    ),
  );
}

describe("FeedbackSubmitForm", () => {
  it.each([
    ["zh-CN", "问题描述"],
    ["en-US", "Issue description"],
  ] as const)("%s 问题描述明确声明必填并提供可访问名称", (locale, label) => {
    const html = renderFeedbackSubmitForm(locale);
    expect(html).toMatch(/<span[^>]*aria-hidden="true"[^>]*>\*<\/span>/);
    const textarea = html.match(/<textarea\b[^>]*>/)?.[0];
    expect(textarea).toContain('required=""');
    expect(textarea).toContain('aria-required="true"');
    expect(textarea).toContain(`aria-label="${label}"`);
  });

  it("uses English copy when the app locale is English", () => {
    const html = renderFeedbackSubmitForm("en-US");

    expect(html).toContain("Issue description");
    expect(html).toContain("Screenshots");
    expect(html).not.toContain(">Logs</h3>");
    expect(html).toContain("Upload diagnostic logs");
    expect(html).toContain("On by default");
    expect(html).toContain("safe projection of CLI configuration");
    expect(html).toContain("model-call traces");
    expect(html).not.toContain("问题描述");
    expect(html).not.toContain("反馈类型");
  });

  it("从当前模型配置读取选中的模型展示名", () => {
    const selectedModel = "315c04c4-1234-5678-9abc-000000000000/claude-opus-4-7";

    const context = readCurrentAgentModelContext([
      {
        id: "model",
        name: "模型",
        category: "model",
        type: "select",
        currentValue: selectedModel,
        options: [
          { value: "another-model", name: "b2" },
          { value: selectedModel, name: "a1" },
        ],
      },
    ]);

    expect(context).toEqual({
      model: selectedModel,
      display: "a1",
      optionCount: 2,
      optionsPreview: ["b2", "a1"],
    });
  });

  it("不再展示旧提交弹窗里的分类字段，但保留简化日志开关", () => {
    const html = renderFeedbackSubmitForm();

    expect(html).toContain("问题描述");
    expect(html).toContain("截图");
    expect(html).toContain("联系方式");
    expect(html).toContain("日志");
    expect(html).toContain("上传诊断日志");
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("默认开启");
    expect(html).toContain("CLI 配置中的安全投影");
    expect(html).toContain("当天模型调用轨迹");
    expect(html).not.toContain("Issue description");
    expect(html).not.toContain("Screenshots");
    expect(html).not.toContain("反馈类型");
    expect(html).not.toContain("功能模块");
    expect(html).not.toContain("影响程度");
    expect(html).not.toContain("当前模型型号");
    expect(html).not.toContain("附带完整日志");
  });

  it("截图附件区域保持可聚焦，方便用户定位截图上传入口", () => {
    const html = renderFeedbackSubmitForm();

    expect(html).toContain("粘贴、拖拽图片到这里，或选择文件。");
    expect(html).toContain('tabindex="0"');
  });

  it("只有存在后台附件上传时才在工单创建后收起提交窗口", () => {
    expect(shouldAutoCloseFeedbackOnTicketCreated({ includeLogs: true, screenshotCount: 0 })).toBe(
      true,
    );
    expect(shouldAutoCloseFeedbackOnTicketCreated({ includeLogs: false, screenshotCount: 1 })).toBe(
      true,
    );
    expect(shouldAutoCloseFeedbackOnTicketCreated({ includeLogs: false, screenshotCount: 0 })).toBe(
      false,
    );
  });

  it("提交 helper 会保留入口预设的反馈类型和日志开关", async () => {
    const feedbackService = createFeedbackService();
    vi.mocked(feedbackService.getDeviceSnapshot).mockResolvedValue({});
    vi.mocked(feedbackService.create).mockResolvedValue(createTicket("ticket-feature"));
    const completed = vi.fn();
    const ticketCreated = vi.fn();
    const job = await startSimplifiedFeedbackSubmission({
      feedbackService,
      title: "增加帮助菜单",
      description: "  我想建议：增加帮助菜单  \n",
      contact: "",
      screenshots: [],
      includeLogs: false,
      ticketType: "feature",
      ticketSeverity: "P3-低",
      ticketModule: "其它",
      modelContext: {},
      locale: "zh-CN",
      formatMessage: (descriptor: { id: string }) => descriptor.id,
      copy: {
        connectingLabel: "connecting",
        connectingDetail: "detail",
        cancelingCreateLabel: "canceling",
        cancelingCreateDetail: "canceling detail",
        canceledLabel: "canceled",
        canceledDetail: "canceled detail",
        uploadingScreenshotLabel: "uploading",
        submittedLabel: "submitted",
        submittedDetail: "submitted detail",
        failedLabel: "failed",
        networkErrorDetail: "network error",
        postCreateNetworkErrorDetail: "created but upload failed",
        pausingLogLabel: "paused",
        pausingLogDetail: "paused detail",
        exportingLogLabel: "exporting",
        exportingLogDetail: "exporting detail",
        uploadingLogLabel: "uploading log",
        logUploadSuccessLabel: "log done",
        logUploadPausedLabel: "log paused",
        logUploadPausedDetail: "log paused detail",
        preparingUploadDetail: "preparing",
      },
      onTicketCreated: ticketCreated,
      onCompleted: completed,
      onError: vi.fn(),
    });

    await job.done.finally(() => dismissFeedbackSubmissionJob(job.id));

    expect(feedbackService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "增加帮助菜单",
        type: "feature",
        severity: "P3-低",
        module: "其它",
        description: expect.stringContaining("反馈类型: feature"),
      }),
      expect.objectContaining({
        operationId: expect.stringMatching(/^feedback-create-/),
      }),
    );
    expect(feedbackService.prepareCompactLogArchive).not.toHaveBeenCalled();
    expect(ticketCreated).toHaveBeenCalledWith("ticket-feature");
    expect(completed).toHaveBeenCalledWith("ticket-feature");
    expect(job.formDraft).toEqual({
      title: "增加帮助菜单",
      description: "  我想建议：增加帮助菜单  \n",
      contact: "",
      screenshots: [],
      includeLogs: false,
      type: "feature",
      severity: "P3-低",
      module: "其它",
    });
    expect(Object.isFrozen(job.formDraft)).toBe(true);
    expect(Object.isFrozen(job.formDraft.screenshots)).toBe(true);
  });
});
