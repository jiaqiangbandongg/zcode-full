import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/LexicalChatInput.js", async () => {
  const React = await import("react");
  return {
    LexicalChatInput: () => React.createElement("div", { "data-testid": "lexical-input" }),
  };
});

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/prompt-editor/ChatPromptActionMenu.js", async () => {
  const React = await import("react");
  return {
    ChatPromptActionMenu: ({
      excludedSlashCommandNames,
    }: {
      excludedSlashCommandNames?: readonly string[];
    }) =>
      React.createElement("div", {
        "data-testid": "composer-action-menu",
        "data-excluded": excludedSlashCommandNames?.join(","),
      }),
  };
});

vi.mock("@/prompt-editor/usePromptEditorDragState.js", () => ({
  usePromptEditorDragState: () => ({
    externalFileDragging: false,
    internalDragging: false,
    setExternalFileDragging: vi.fn(),
    setInternalDragging: vi.fn(),
    setWorkspaceFileDragging: vi.fn(),
    workspaceFileDragging: false,
  }),
}));

describe("ChatPromptEditor action menu", () => {
  it("passes side chat command exclusions to the action menu", () => {
    const html = renderToStaticMarkup(
      createElement(ChatPromptEditor, {
        workspacePath: "/tmp/workspace",
        taskId: null,
        submitLabel: "Send",
        showMentionButton: true,
        excludedSlashCommandNames: ["goal"],
        onSubmit: vi.fn(),
      }),
    );
    expect(html).toContain('data-excluded="goal"');
  });

  // Side Pane 完整视图浮窗：[+] 输入区 [控件][发送] 排成一行（docs/ui/side-pane-full-view.md）。
  it("moves the action menu before the editor only in the inline layout", () => {
    const render = (layout: "stacked" | "inline") =>
      renderToStaticMarkup(
        createElement(ChatPromptEditor, {
          workspacePath: "/tmp/workspace",
          taskId: null,
          submitLabel: "Send",
          showMentionButton: true,
          layout,
          onSubmit: vi.fn(),
        }),
      );
    const order = (html: string) =>
      ["composer-action-menu", "lexical-input", "data-composer-leading-content"].map((marker) =>
        html.indexOf(marker),
      );

    const inline = render("inline");
    expect(inline).toContain('data-composer-layout="inline"');
    const [inlineMenu, inlineEditor, inlineToolbar] = order(inline);
    expect(inlineMenu).toBeLessThan(inlineEditor);
    expect(inlineEditor).toBeLessThan(inlineToolbar);

    const stacked = render("stacked");
    expect(stacked).toContain('data-composer-layout="stacked"');
    const [stackedMenu, stackedEditor, stackedToolbar] = order(stacked);
    expect(stackedEditor).toBeLessThan(stackedToolbar);
    expect(stackedToolbar).toBeLessThan(stackedMenu);
  });
});
