// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationShareSuccessDock } from "@/v4/ConversationShareSuccessDock.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values ? `${id}:${JSON.stringify(values)}` : id,
    },
  }),
}));

afterEach(() => cleanup());

describe("ConversationShareSuccessDock", () => {
  it("成功态只保留标题和打开/复制两个业务操作", () => {
    const onOpen = vi.fn();
    const onCopy = vi.fn();
    const onDismiss = vi.fn();

    render(
      createElement(ConversationShareSuccessDock, {
        title: "每日 AI 新闻汇总",
        onOpen,
        onCopy,
        onDismiss,
      }),
    );

    const dock = screen.getByTestId("conversation-share-success-dock");
    expect(dock).toBeTruthy();
    expect(dock.className).toContain("w-full");
    expect(dock.className).not.toContain("max-w-[43.75rem]");
    expect(dock.className).toContain("border-input-border");
    expect(dock.className).toContain("bg-input");
    expect(dock.className).toContain("text-foreground");
    expect(dock.className).not.toContain("bg-popover");
    expect(dock.className).not.toContain("text-popover-foreground");
    expect(dock.className).not.toContain("shadow-lg");
    expect(dock.className).not.toContain("ring-1");
    expect(screen.getByTestId("conversation-share-success-status").textContent).toContain(
      "conversationShare.result.title",
    );
    expect(screen.getByTestId("conversation-share-result-title").textContent).toBe(
      "每日 AI 新闻汇总",
    );
    expect(screen.queryByTestId("conversation-share-permission-picker")).toBeNull();
    expect(screen.queryByTestId("conversation-share-back")).toBeNull();
    expect(screen.queryByText("conversationShare.partial.cancel")).toBeNull();
    expect(screen.queryByTestId("conversation-share-selection-hint")).toBeNull();

    const actions = screen
      .getByTestId("conversation-share-success-actions")
      .querySelectorAll("button");
    expect(actions).toHaveLength(2);
    expect([...actions].map((action) => action.getAttribute("data-size"))).toEqual(["lg", "lg"]);
    expect(screen.getByTestId("conversation-share-open-browser").getAttribute("data-variant")).toBe(
      "outline",
    );
    expect(screen.getByTestId("conversation-share-copy-link").getAttribute("data-variant")).toBe(
      "default",
    );
    fireEvent.click(screen.getByTestId("conversation-share-open-browser"));
    fireEvent.click(screen.getByTestId("conversation-share-copy-link"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("conversation-share-success-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("部分成功时保留成功状态并展示被跳过文件提示", () => {
    render(
      createElement(ConversationShareSuccessDock, {
        title: "Share",
        onOpen: vi.fn(),
        onCopy: vi.fn(),
        onDismiss: vi.fn(),
        warnings: {
          issueCount: 2,
          issues: [
            {
              code: "artifact_read_failed",
              scope: "artifact",
              artifactDisplayName: "报告.pdf",
            },
          ],
        },
      }),
    );

    expect(screen.getByTestId("conversation-share-success-status").textContent).toContain(
      "conversationShare.result.title",
    );
    expect(screen.getByTestId("conversation-share-success-warning").textContent).toContain("2");
  });
});
