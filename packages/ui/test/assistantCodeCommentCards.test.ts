// @vitest-environment jsdom
import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantCodeCommentCards } from "@/AssistantCodeCommentCards.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { AssistantCodeCommentCard } from "@/lib/assistantCodeComment.js";

function card(index: number): AssistantCodeCommentCard {
  return {
    id: `comment-${index}`,
    title: `[P1] 风险 ${index}`,
    body: `需要修复 ${index}`,
    file: `src/file-${index}.ts`,
    path: `/workspace/src/file-${index}.ts`,
    displayPath: `src/file-${index}.ts`,
    priority: 1,
    startLine: index,
    endLine: index + 1,
    sourceStart: index,
    sourceEnd: index + 1,
  };
}

describe("AssistantCodeCommentCards", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it("默认折叠；每条只占一行，正文不展示 body，文字可选择且整行打开只读 Code Review", () => {
    const onOpenCodeViewer = vi.fn();
    render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(AssistantCodeCommentCards, {
          cards: Array.from({ length: 7 }, (_, index) => card(index + 1)),
          workspacePath: "/workspace",
          workspaceIdentity: "remote:ssh:demo:/workspace",
          workspaceRemoteSessionId: "remote-1",
          onOpenCodeViewer,
        }),
      ),
    );

    expect(screen.getByText("7 条评论")).toBeTruthy();
    expect(screen.queryByText("风险 1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /展开 7 条评论/ }));
    expect(screen.getByText("风险 1")).toBeTruthy();
    expect(screen.getByText("风险 6")).toBeTruthy();
    expect(screen.queryByText("需要修复 1")).toBeNull();

    const firstCard = screen.getByRole("button", { name: /风险 1/ });
    expect(screen.getByText("src/file-1.ts:1–2")).toBeTruthy();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(screen.getByText("风险 1"));
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.click(firstCard);
    expect(onOpenCodeViewer).not.toHaveBeenCalled();

    selection?.removeAllRanges();
    fireEvent.click(firstCard);
    expect(onOpenCodeViewer).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "code-review",
        title: "file-1.ts",
        path: "/workspace/src/file-1.ts",
        workspacePath: "/workspace",
        workspaceIdentity: "remote:ssh:demo:/workspace",
        workspaceRemoteSessionId: "remote-1",
        review: {
          requestId: expect.stringContaining("comment-1:"),
          title: "风险 1",
          body: "需要修复 1",
          priority: 1,
          startLine: 1,
          endLine: 2,
        },
      }),
    );

    fireEvent.keyDown(firstCard, { key: "Enter" });
    fireEvent.keyDown(firstCard, { key: " " });
    expect(onOpenCodeViewer).toHaveBeenCalledTimes(3);
  });
});
