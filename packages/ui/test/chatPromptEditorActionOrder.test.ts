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

describe("ChatPromptEditor action order", () => {
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
  it("renders the + action menu before the permission mode selector", () => {
    const html = renderToStaticMarkup(
      createElement(ChatPromptEditor, {
        workspacePath: "/tmp/workspace",
        taskId: "session-1",
        submitLabel: "Send",
        showMentionButton: true,
        leadingActions: createElement("span", {
          "data-testid": "permission-mode-selector",
        }),
        onSubmit: vi.fn(),
      }),
    );

    const actionMenuIndex = html.indexOf('data-testid="composer-action-menu"');
    const permissionModeIndex = html.indexOf('data-testid="permission-mode-selector"');

    expect(actionMenuIndex).toBeGreaterThanOrEqual(0);
    expect(permissionModeIndex).toBeGreaterThanOrEqual(0);
    expect(actionMenuIndex).toBeLessThan(permissionModeIndex);
  });
});
