// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationShareConfirmationDock } from "@/v4/ConversationShareConfirmationDock.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values ? `${id}:${JSON.stringify(values)}` : id,
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ConversationShareConfirmationDock error details", () => {
  it.each([false, true])("浮窗 warning 与抖动尊重减少动态效果 %s", (reducedMotion) => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: reducedMotion })),
    );
    const onConfirm = vi.fn();
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onEditSelection: vi.fn(),
        onConfirm,
      }),
    );
    const section = screen.getByTestId("conversation-share-disclosure");
    section.animate = vi.fn();
    section.scrollIntoView = vi.fn();
    const row = section.querySelector("label")!;
    const cancel = vi.fn();
    row.animate = vi.fn(() => ({ cancel }) as unknown as Animation);
    fireEvent.click(screen.getByTestId("conversation-share-confirm"));
    const checkbox = screen.getByTestId("conversation-share-disclosure-checkbox");
    expect(checkbox.getAttribute("aria-invalid")).toBe("true");
    expect(checkbox.closest("label")?.className).toContain("text-warning");
    expect(checkbox.className).not.toContain("border-destructive");
    expect(document.activeElement).toBe(checkbox);
    expect(section.animate).not.toHaveBeenCalled();
    if (reducedMotion) {
      expect(row.animate).not.toHaveBeenCalled();
    } else {
      expect(row.animate).toHaveBeenCalledWith(
        expect.arrayContaining([{ transform: "translateX(-4px)" }]),
        { duration: 280, easing: "ease-out" },
      );
      fireEvent.click(screen.getByTestId("conversation-share-confirm"));
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(row.animate).toHaveBeenCalledTimes(2);
    }
    expect(section.scrollIntoView).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(checkbox);
    expect(checkbox.getAttribute("aria-invalid")).toBe("false");
    if (!reducedMotion) expect(cancel).toHaveBeenCalledTimes(2);
    expect(checkbox.closest("label")?.className).not.toContain("text-warning");
    expect(onConfirm).not.toHaveBeenCalled();
  });
  it("浮窗发布中只展示进度，失败后恢复重试操作", () => {
    const props = {
      selectedCount: 2,
      totalCount: 3,
      title: "当前任务",
      onCancel: vi.fn(),
      onEditSelection: vi.fn(),
      onConfirm: vi.fn(),
    };
    const { rerender } = render(
      createElement(ConversationShareConfirmationDock, { ...props, pending: true }),
    );
    expect(screen.queryByTestId("conversation-share-confirm")).toBeNull();
    expect(screen.getByTestId("conversation-share-publish-progress").textContent).toContain(
      "当前任务",
    );
    rerender(
      createElement(ConversationShareConfirmationDock, {
        ...props,
        error: { issues: [], issueCount: 0 },
      }),
    );
    expect(screen.getByTestId("conversation-share-confirm").textContent).toContain(
      "conversationShare.publish.retry",
    );
  });
  it("将检查状态放进分享范围按钮并在完成后恢复摘要", () => {
    const props = {
      selectedCount: 2,
      totalCount: 4,
      onEditSelection: vi.fn(),
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    };
    const { rerender } = render(
      createElement(ConversationShareConfirmationDock, { ...props, preflightChecking: true }),
    );
    const button = screen.getByTestId("conversation-share-adjust");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.textContent).toContain("conversationShare.partial.preflightChecking");
    rerender(
      createElement(ConversationShareConfirmationDock, { ...props, preflightChecking: false }),
    );
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(button.textContent).toContain("conversationShare.range.selected");
  });
  it("keeps the failed publish phase and its last progress instead of showing 100%", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 2,
        totalCount: 3,
        progressLabel: "Uploading artifacts",
        progressPhase: "uploading",
        error: {
          issueCount: 1,
          issues: [{ code: "upload_incomplete", scope: "artifact", phase: "uploading" }],
        },
        onCancel: vi.fn(),
        onEditSelection: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    const progress = screen.getByRole("progressbar");
    expect(progress.getAttribute("aria-valuenow")).toBe("58");
    expect(
      progress
        .querySelector('[data-testid="conversation-share-progress-fill"]')
        ?.getAttribute("style"),
    ).toContain("width: 58%");
    expect(
      screen
        .getByTestId("conversation-share-publish-phase-uploading")
        .getAttribute("data-phase-state"),
    ).toBe("failed");
    expect(
      screen
        .getByTestId("conversation-share-publish-phase-collecting")
        .getAttribute("data-phase-state"),
    ).toBe("complete");
  });

  it("keeps retry available after an error even when the disclosure checkbox is not rendered", () => {
    const onConfirm = vi.fn();
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        title: "Share",
        disclosureAccepted: false,
        error: {
          issueCount: 1,
          messageId: "conversationShare.error.network",
          issues: [{ code: "unknown", scope: "transport", phase: "collecting" }],
        },
        onCancel: vi.fn(),
        onEditSelection: vi.fn(),
        onConfirm,
      }),
    );

    const retry = screen.getByTestId("conversation-share-confirm");
    expect(retry).toHaveProperty("disabled", false);
    fireEvent.click(retry);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps the publish progress in the same dock and removes edit actions", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 2,
        totalCount: 3,
        progressLabel: "Uploading artifacts",
        progressPhase: "uploading",
        pending: true,
        onCancel: vi.fn(),
        onEditSelection: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    expect(screen.getByTestId("conversation-share-publish-progress").textContent).toContain(
      "Uploading artifacts",
    );
    expect(screen.queryByTestId("conversation-share-publish-lock-note")).toBeNull();
    expect(screen.queryByTestId("conversation-share-disclosure-checkbox")).toBeNull();
    expect(screen.queryByTestId("conversation-share-back")).toBeNull();
    expect(screen.queryByText("conversationShare.partial.cancel")).toBeNull();
    expect(screen.queryByTestId("conversation-share-confirm")).toBeNull();
  });

  it("renders the uploading phase message while pending", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 3,
        totalCount: 3,
        progressLabel: "Uploading artifacts",
        progressPhase: "uploading",
        completedArtifacts: 2,
        totalArtifacts: 3,
        pending: true,
        onCancel: vi.fn(),
        onEditSelection: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    expect(screen.getByTestId("conversation-share-publish-phase-uploading").textContent).toContain(
      "conversationShare.phase.uploadingActive",
    );
  });

  it("keeps disclosure confirmation inside the dock before publishing", () => {
    const onDisclosureAcceptedChange = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 2,
        totalCount: 3,
        onCancel: vi.fn(),
        onEditSelection: vi.fn(),
        onConfirm,
        disclosureAccepted: false,
        onDisclosureAcceptedChange,
      }),
    );

    const disclosure = screen.getByTestId("conversation-share-disclosure-checkbox");
    const confirm = screen.getByTestId("conversation-share-confirm");
    expect(screen.getByTestId("conversation-share-disclosure").textContent).not.toContain(
      "conversationShare.publicWarning",
    );
    expect(disclosure.getAttribute("aria-checked")).toBe("false");
    expect(confirm).toHaveProperty("disabled", false);
    expect(screen.queryByTestId("conversation-share-disclosure-confirm")).toBeNull();

    fireEvent.click(disclosure);
    expect(onDisclosureAcceptedChange).toHaveBeenCalledWith(true);

    rerender(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 2,
        totalCount: 3,
        onCancel: vi.fn(),
        onEditSelection: vi.fn(),
        onConfirm,
        disclosureAccepted: true,
        onDisclosureAcceptedChange,
      }),
    );
    expect(screen.getByTestId("conversation-share-confirm")).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByTestId("conversation-share-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("默认权限为可导入并继续", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onEditSelection: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );
    expect(screen.getByRole("combobox").textContent).toContain(
      "conversationShare.permission.linkEditor",
    );
  });

  it("opens the sensitive-content review scope above the disclosure and toggles it closed", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onEditSelection: vi.fn(),
        onConfirm: vi.fn(),
      }),
    );

    const trigger = screen.getByTestId("conversation-share-disclosure-scope-trigger");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("conversation-share-disclosure-scope-content")).toBeNull();

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const content = screen.getByTestId("conversation-share-disclosure-scope-content");
    expect(content.textContent).toContain("conversationShare.disclosure.scope.title");
    expect(content.textContent).toContain("conversationShare.disclosure.scope.conversation");
    expect(content.textContent).toContain("conversationShare.disclosure.scope.sensitive");

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("conversation-share-disclosure-scope-content")).toBeNull();
  });

  it("renders actionable artifact details and deselects the affected turn", () => {
    const onDeselectTurn = vi.fn();
    const onCopyRequestId = vi.fn();
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 2,
        title: "Share",
        onCancel: vi.fn(),
        onEditSelection: vi.fn(),
        onConfirm: vi.fn(),
        error: {
          issueCount: 1,
          requestId: "server-request-123",
          issues: [
            {
              code: "artifact_type_not_allowed",
              scope: "artifact",
              // turnOrdinal 只用于文案；「取消该轮」按 productTurnId 定位。
              turnOrdinal: 2,
              productTurnId: "product-turn-2",
              artifactDisplayName: "晨报.pdf",
              artifactType: "pdf",
              extension: "pdf",
              mimeType: "application/pdf",
              allowedFormats: ["PPTX (.pptx)", "DOCX (.docx)"],
            },
          ],
        },
        onDeselectTurn,
        onCopyRequestId,
      }),
    );

    expect(screen.getByTestId("conversation-share-error-details").textContent).toContain(
      "晨报.pdf",
    );
    expect(screen.getByTestId("conversation-share-error-details").textContent).toContain("pdf");
    const errorDetails = screen.getByTestId("conversation-share-error-details");
    expect(errorDetails.textContent).not.toContain("server-request-123");
    expect(screen.queryByTestId("conversation-share-request-id-content")).toBeNull();
    const requestDetailsTrigger = screen.getByTestId("conversation-share-request-id-trigger");
    expect(requestDetailsTrigger.getAttribute("aria-label")).toBe(
      "conversationShare.issue.details",
    );
    fireEvent.click(requestDetailsTrigger);
    expect(screen.getByTestId("conversation-share-request-id-content").textContent).toContain(
      "server-request-123",
    );
    fireEvent.click(screen.getByRole("button", { name: "conversationShare.issue.copyRequestId" }));
    expect(onCopyRequestId).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "conversationShare.issue.deselectTurn" }));
    expect(onDeselectTurn).toHaveBeenCalledWith("product-turn-2");
  });

  it("shows a stable missing request id state without a copy action", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onEditSelection: vi.fn(),
        onConfirm: vi.fn(),
        error: {
          issueCount: 1,
          issues: [{ code: "unknown", scope: "transport" }],
        },
      }),
    );

    expect(screen.queryByTestId("conversation-share-request-id-content")).toBeNull();
    fireEvent.click(screen.getByTestId("conversation-share-request-id-trigger"));
    expect(screen.getByTestId("conversation-share-request-id-content").textContent).toContain(
      "conversationShare.issue.requestIdMissing",
    );
    expect(
      screen.queryByRole("button", { name: "conversationShare.issue.copyRequestId" }),
    ).toBeNull();
  });

  it("keeps the request id hidden until the inline error details button is opened", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onEditSelection: vi.fn(),
        onConfirm: vi.fn(),
        error: {
          messageId: "conversationShare.error.invalidConversation",
          issueCount: 1,
          requestId: "server-request-456",
          issues: [{ code: "invalid_conversation", scope: "conversation" }],
        },
        onCopyRequestId: vi.fn(),
      }),
    );

    expect(screen.getByTestId("conversation-share-error-message").textContent).toContain(
      "conversationShare.error.invalidConversation",
    );
    expect(screen.getByTestId("conversation-share-error-message").textContent).not.toContain(
      "server-request-456",
    );
    expect(screen.queryByText("server-request-456")).toBeNull();

    fireEvent.click(screen.getByTestId("conversation-share-request-id-trigger"));

    expect(screen.getByTestId("conversation-share-request-id-content").textContent).toContain(
      "server-request-456",
    );
  });

  it("shows the actionable publish error instead of a generic transport issue", () => {
    render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 1,
        totalCount: 1,
        onCancel: vi.fn(),
        onEditSelection: vi.fn(),
        onConfirm: vi.fn(),
        error: {
          messageId: "conversationShare.error.authenticationRequired",
          issueCount: 1,
          issues: [{ code: "unknown", scope: "transport", phase: "collecting" }],
        },
      }),
    );

    const details = screen.getByTestId("conversation-share-error-details");
    expect(screen.getByTestId("conversation-share-confirmation-header").textContent).toContain(
      "conversationShare.publish.failedTitle",
    );
    expect(screen.getByTestId("conversation-share-publish-progress")).toBeTruthy();
    expect(screen.queryByTestId("conversation-share-permission-picker")).toBeNull();
    expect(details.textContent).toContain("conversationShare.error.authenticationRequired");
    expect(details.textContent).not.toContain("conversationShare.issue.unknown");
  });
});

it("浮窗分享范围整行触发调整，不显示独立调整文字", () => {
  const onEditSelection = vi.fn();
  render(
    createElement(ConversationShareConfirmationDock, {
      selectedCount: 2,
      totalCount: 4,
      onEditSelection,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }),
  );
  fireEvent.click(screen.getByTestId("conversation-share-range-summary"));
  expect(onEditSelection).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("conversationShare.range.adjust")).toBeNull();
});

it("shows validation coordinates only inside error details", () => {
  render(
    createElement(ConversationShareConfirmationDock, {
      selectedCount: 1,
      totalCount: 1,
      onCancel: vi.fn(),
      onEditSelection: vi.fn(),
      onConfirm: vi.fn(),
      error: {
        issueCount: 1,
        issues: [],
        code: 3205,
        messageId: "conversationShare.error.invalidConversation",
        rejection: { rule: "field_type", path: "rows[0].state", field: "state", row_index: 0 },
      },
    }),
  );
  expect(screen.queryByText("rows[0].state", { exact: false })).toBeNull();
  fireEvent.click(screen.getByTestId("conversation-share-request-id-trigger"));
  const details = screen.getByTestId("conversation-share-request-id-content");
  expect(details.textContent).toContain("rows[0].state");
  expect(details.textContent).toContain("field_type");
  expect(details.textContent).toContain("rowLabel: 1");
  expect(details.textContent).toContain("3205");
});
