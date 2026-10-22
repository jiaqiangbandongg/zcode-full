// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogHost } from "@/ConfirmDialog.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import zhCN from "@/i18n/locales/zh-CN.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/dialog.js", () => ({
  Dialog: ({
    children,
    onOpenChange,
  }: {
    children?: ReactNode;
    onOpenChange: (open: boolean) => void;
  }) =>
    createElement(
      "div",
      null,
      createElement(
        "button",
        { type: "button", onClick: () => onOpenChange(false) },
        "dismiss-dialog",
      ),
      children,
    ),
  DialogClose: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  DialogContent: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("section", props, children),
  DialogDescription: ({ children }: { children?: ReactNode }) => createElement("p", null, children),
  DialogFooter: ({ children }: { children?: ReactNode }) => createElement("footer", null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) => createElement("header", null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => createElement("h2", null, children),
}));

afterEach(() => {
  cleanup();
  useConfirmDialogStore.getState().settleConfirmation(false);
});

describe("ConfirmDialogHost required acknowledgement", () => {
  it("ignores overlay/Escape dismissal and renders only the acknowledgement action", async () => {
    const result = useConfirmDialogStore.getState().requestConfirmation({
      title: "Source Server ready",
      confirmLabel: "Got it",
      requiredAcknowledgement: true,
    });
    render(createElement(ConfirmDialogHost));

    expect(screen.queryByText("common.cancel")).toBeNull();
    fireEvent.click(screen.getByText("dismiss-dialog"));
    expect(useConfirmDialogStore.getState().pendingRequest).toBeDefined();

    fireEvent.click(screen.getByText("Got it"));
    await expect(result).resolves.toBe(true);
  });

  it("renders the remote continuity comparison with concise user-facing copy", () => {
    void useConfirmDialogStore.getState().requestConfirmation({
      presentation: "source-server-boundary",
      title: "本地离线，任务照常运行",
      description: zhCN["remote.sourceServerBoundaryDescription"],
      confirmLabel: "知道了",
      requiredAcknowledgement: true,
      showKeyboardHints: false,
    });

    render(createElement(ConfirmDialogHost));

    expect(screen.getByTestId("source-server-boundary-dialog")).toBeTruthy();

    expect(screen.getByText("本地离线，任务照常运行")).toBeTruthy();
    expect(screen.getByText("关闭 ZCode 或休眠本机， 远程任务继续运行。").textContent).toBe(
      "关闭 ZCode 或休眠本机，\n远程任务继续运行。",
    );
    expect(screen.getByTestId("source-server-boundary-local").textContent).toContain(
      "remote.sourceServerBoundaryLocalDevice",
    );
    expect(screen.getByTestId("source-server-boundary-remote").textContent).toContain(
      "remote.sourceServerBoundaryRemoteStatus",
    );
    expect(screen.getByRole("button", { name: "知道了" })).toBeTruthy();
  });
});
