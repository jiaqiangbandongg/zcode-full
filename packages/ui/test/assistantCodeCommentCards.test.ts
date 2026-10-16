// @vitest-environment jsdom
import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantCodeCommentCards } from "@/AssistantCodeCommentCards.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
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

  it("只保留当前卡片交互实际消费的本地化 key", () => {
    // Bug 原因：早期“标题 + 数量 + 展开其余五条”的卡片已改成整卡折叠，旧文案却未同步删除，
    // 容易让后续维护者误以为仍存在第二套展开交互。
    const expectedKeys = [
      "chat.codeCommentCards.collapseAll",
      "chat.codeCommentCards.expandAll",
      "chat.codeCommentCards.openReview",
    ];

    for (const messages of [enUS, zhCN]) {
      expect(
        Object.keys(messages)
          .filter((key) => key.startsWith("chat.codeCommentCards."))
          .sort(),
      ).toEqual(expectedKeys);
    }
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
    const shell = screen.getByTestId("assistant-code-comment-cards");
    expect(shell.className).toContain("bg-card");
    expect(shell.className).toContain("border-border");
    expect(shell.className).toContain("shadow-none");
    const header = screen.getByTestId("assistant-code-comment-header");
    expect(header.className).toContain("h-10");
    expect(header.className).toContain("hover:bg-hover");
    expect(header.className).toContain("transition-colors");
    expect(header.className).not.toContain("h-8");
    expect(header.className).not.toContain("min-h-20");
    expect(screen.getByText("7 条评论").className).toContain("text-ui-base");
    const list = screen.getByTestId("assistant-code-comment-list");
    expect(list.className).not.toContain("divide-y");
    expect(list.className).not.toContain("border-t");
    const toggleIcon = screen.getByTestId("assistant-code-comment-toggle-icon");
    expect(toggleIcon.className).toContain("size-1.5");
    expect(toggleIcon.className).toContain("-rotate-45");
    expect(screen.queryByText("风险 1")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /展开 7 条评论/ }));
    expect(list.className).toContain("border-t");
    expect(list.className).toContain("border-border");
    expect(screen.getByText("风险 1")).toBeTruthy();
    expect(screen.getByText("风险 6")).toBeTruthy();
    expect(screen.queryByText("需要修复 1")).toBeNull();
    expect(screen.getByTestId("assistant-code-comment-toggle-icon").className).toContain(
      "rotate-45",
    );

    const firstCard = screen.getByRole("button", { name: /风险 1/ });
    const firstCardSurface = firstCard.parentElement;
    expect(firstCardSurface).not.toBeNull();
    expect(firstCardSurface?.className).toContain("bg-background/50");
    expect(firstCard.className).toContain("select-text");
    expect(firstCard.className).toContain("whitespace-nowrap");
    expect(firstCard.className).toContain("min-h-10");
    expect(firstCard.className).toContain("py-2");
    expect(firstCard.className).not.toContain("bg-background/50");
    expect(firstCard.className).toContain("hover:bg-hover/30");
    expect(firstCard.className).not.toContain("hover:bg-surface-hover");
    expect(firstCard.querySelector("p")).toBeNull();
    expect(screen.getByText("src/file-1.ts:1–2")).toBeTruthy();
    expect(firstCard.querySelector("svg")).toBeNull();

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
