import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IFeedbackService } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { FeedbackSubmitForm } from "@/feedback/FeedbackSubmitForm.js";
import type {
  FeedbackSubmissionJob,
  FeedbackSubmissionJobState,
} from "@/feedback/feedbackSubmissionJob.js";

const formCapture = vi.hoisted(() => ({
  contactProps: null as Record<string, unknown> | null,
  descriptionProps: null as Record<string, unknown> | null,
  footerProps: null as Record<string, unknown> | null,
  screenshotProps: null as Record<string, unknown> | null,
  logProps: null as Record<string, unknown> | null,
  getSubmissionJob: vi.fn(),
  startSubmission: vi.fn(),
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/feedback/feedbackBadges.js", async () => {
  const React = await import("react");
  return {
    FeedbackErrorTip: ({ message }: { message: string }) =>
      React.createElement("div", { "data-error": message }),
  };
});
vi.mock("@/feedback/feedbackContactPreference.js", () => ({
  readFeedbackContactPreference: () => "user@example.com",
}));
vi.mock("@/feedback/FeedbackScreenshotPicker.js", async () => {
  const React = await import("react");
  return {
    FeedbackScreenshotPicker: (props: Record<string, unknown>) => {
      formCapture.screenshotProps = props;
      return React.createElement("div");
    },
    readScreenshotDraft: vi.fn(),
  };
});
vi.mock("@/feedback/FeedbackSubmitSections.js", async () => {
  const React = await import("react");
  return {
    ContactSection: (props: Record<string, unknown>) => {
      formCapture.contactProps = props;
      return React.createElement("div");
    },
    DescriptionSection: (props: Record<string, unknown>) => {
      formCapture.descriptionProps = props;
      return React.createElement("div");
    },
    LogUploadToggle: (props: Record<string, unknown>) => {
      formCapture.logProps = props;
      return React.createElement("div");
    },
    Section: ({ children }: { children?: unknown }) => React.createElement("div", null, children),
    SubmitFooter: (props: Record<string, unknown>) => {
      formCapture.footerProps = props;
      return React.createElement("div");
    },
  };
});
vi.mock("@/components/ui/scroll-fade-viewport.js", async () => {
  const React = await import("react");
  return {
    ScrollFadeViewport: ({ children }: { children?: unknown }) =>
      React.createElement("div", null, children),
  };
});
vi.mock("@/feedback/feedbackSubmitModelContext.js", () => ({
  readCurrentAgentModelContext: () => ({}),
}));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn() },
}));
vi.mock("@/feedback/feedbackSubmissionJob.js", () => ({
  cancelFeedbackCreateSubmissionJob: vi.fn(),
  getFeedbackSubmissionJob: formCapture.getSubmissionJob,
}));
vi.mock("@/feedback/feedbackSubmissionCopy.js", () => ({
  useFeedbackSubmissionCopy: () => ({
    connectingLabel: "connecting",
    connectingDetail: "connecting detail",
    failedLabel: "failed",
    networkErrorDetail: "network error",
    postCreateNetworkErrorDetail: "created but upload failed",
  }),
}));
vi.mock("@/feedback/feedbackSubmitSubmission.js", () => ({
  DEFAULT_FEEDBACK_MODULE: "其它",
  DEFAULT_FEEDBACK_SEVERITY: "P2-中",
  DEFAULT_FEEDBACK_TYPE: "bug",
  startSimplifiedFeedbackSubmission: formCapture.startSubmission,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "en-US",
  }),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ activeWorkspaceIdentity: null, activeWorkspacePath: null }),
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  selectWorkspaceZCodeState: () => null,
  useZCodeSessionStore: (selector: (state: Record<string, unknown>) => unknown) => selector({}),
}));

const mountedRoots: Root[] = [];

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: { removeProperty: () => {}, setProperty: () => {} },
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom(): Element {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    setTimeout,
  };
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentMock });
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowMock });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock, "div");
}

function getCapturedSubmit(): () => Promise<void> {
  const submit = formCapture.footerProps?.onSubmit;
  if (typeof submit !== "function") {
    throw new Error("Feedback submit handler was not rendered");
  }
  return submit as () => Promise<void>;
}

function createSubmissionJobFixture(
  state: FeedbackSubmissionJobState,
  overrides: Partial<FeedbackSubmissionJob> = {},
): FeedbackSubmissionJob {
  return {
    id: state.id,
    formDraft: {
      description: "",
      screenshots: [],
      includeLogs: false,
      type: "bug",
    },
    done: new Promise(() => {}),
    getState: () => state,
    subscribe: (listener) => {
      listener(state);
      return { dispose: vi.fn() };
    },
    cancelSubmission: vi.fn(),
    cancelActiveUpload: vi.fn(),
    continueLogUpload: vi.fn(),
    ...overrides,
  };
}

describe("FeedbackSubmitForm retry", () => {
  beforeEach(() => {
    formCapture.contactProps = null;
    formCapture.descriptionProps = null;
    formCapture.footerProps = null;
    formCapture.screenshotProps = null;
    formCapture.getSubmissionJob.mockReset();
    formCapture.getSubmissionJob.mockReturnValue(null);
    formCapture.startSubmission.mockReset();
  });

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount());
    }
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([undefined, false, true])(
    "preserves draft log choice %s and submits user opt-out",
    async (includeLogs) => {
      const root = createRoot(installMinimalDom());
      mountedRoots.push(root);
      formCapture.startSubmission.mockResolvedValue(
        createSubmissionJobFixture({
          id: "log-choice",
          status: "running",
          progress: { label: "connecting" },
        }),
      );
      await act(async () => {
        root.render(
          createElement(FeedbackSubmitForm, {
            feedbackService: {} as IFeedbackService,
            platform: {} as IPlatformService,
            initialDraft: { description: "日志默认值", includeLogs },
            onSubmitted: vi.fn(),
            onViewTickets: vi.fn(),
            onCancel: vi.fn(),
          }),
        );
      });
      expect(formCapture.logProps?.checked).toBe(includeLogs ?? true);
      act(() => (formCapture.logProps?.onCheckedChange as (checked: boolean) => void)(false));
      await act(async () => {
        await getCapturedSubmit()();
      });
      expect(formCapture.startSubmission).toHaveBeenCalledWith(
        expect.objectContaining({ includeLogs: false }),
      );
    },
  );

  it("keeps description, screenshot, and contact when a network failure is retried", async () => {
    let state: FeedbackSubmissionJobState = {
      id: "feedback-retry",
      status: "running",
      progress: { label: "connecting" },
    };
    let stateListener: ((next: FeedbackSubmissionJobState) => void) | undefined;
    const job = createSubmissionJobFixture(state, {
      getState: () => state,
      subscribe: (listener) => {
        stateListener = listener;
        listener(state);
        return { dispose: vi.fn() };
      },
    });
    formCapture.startSubmission.mockResolvedValue(job);

    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        createElement(FeedbackSubmitForm, {
          feedbackService: {} as IFeedbackService,
          platform: {} as IPlatformService,
          initialDraft: {
            description: "用户现场描述",
            screenshots: [
              {
                filename: "现场.png",
                contentType: "image/png",
                dataBase64: "ZmFrZQ==",
                size: 4,
              },
            ],
          },
          onSubmitted: vi.fn(),
          onViewTickets: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
    });

    await act(async () => {
      await getCapturedSubmit()();
    });
    state = {
      id: job.id,
      status: "error",
      error: "Check your network, VPN, or proxy settings, then try again.",
      progress: { label: "failed", detail: "network error" },
    };
    act(() => stateListener?.(state));

    expect(formCapture.descriptionProps?.value).toBe("用户现场描述");
    expect(formCapture.contactProps?.value).toBe("user@example.com");
    expect(formCapture.screenshotProps?.screenshots).toEqual([
      expect.objectContaining({ filename: "现场.png", dataBase64: "ZmFrZQ==" }),
    ]);

    await act(async () => {
      await getCapturedSubmit()();
    });
    expect(formCapture.startSubmission).toHaveBeenCalledTimes(2);
    expect(formCapture.startSubmission).toHaveBeenLastCalledWith(
      expect.objectContaining({
        contact: "user@example.com",
        description: "用户现场描述",
        screenshots: [expect.objectContaining({ filename: "现场.png", dataBase64: "ZmFrZQ==" })],
      }),
    );
  });

  it("restores the selected background job's original form draft", async () => {
    const state: FeedbackSubmissionJobState = {
      id: "feedback-background-a",
      status: "running",
      ticketId: "ticket-a",
      progress: { label: "uploading logs" },
    };
    const job = createSubmissionJobFixture(state, {
      formDraft: {
        description: "卡片 A 的用户原始问题描述",
        contact: "card-a@example.com",
        screenshots: [
          {
            filename: "card-a.png",
            contentType: "image/png",
            dataBase64: "Y2FyZC1h",
            size: 6,
          },
        ],
        includeLogs: true,
        type: "bug",
        severity: "P1-高",
        module: "UI布局 / 交互",
      },
    });
    formCapture.getSubmissionJob.mockReturnValue(job);

    const root = createRoot(installMinimalDom());
    mountedRoots.push(root);
    await act(async () => {
      root.render(
        createElement(FeedbackSubmitForm, {
          feedbackService: {} as IFeedbackService,
          platform: {} as IPlatformService,
          submissionJobId: job.id,
          onSubmitted: vi.fn(),
          onViewTickets: vi.fn(),
          onCancel: vi.fn(),
        }),
      );
    });

    expect(formCapture.getSubmissionJob).toHaveBeenCalledWith(job.id);
    expect(formCapture.descriptionProps?.value).toBe("卡片 A 的用户原始问题描述");
    expect(formCapture.contactProps?.value).toBe("card-a@example.com");
    expect(formCapture.screenshotProps?.screenshots).toEqual([
      expect.objectContaining({
        filename: "card-a.png",
        dataBase64: "Y2FyZC1h",
      }),
    ]);
  });
});
