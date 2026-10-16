// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useRemoteConnectionEntryVisibility.js", () => ({
  useRemoteConnectionEntryVisibility: () => true,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/SSHDialog.js", () => ({
  SSHDialog: ({ open }: { open?: boolean }) =>
    open
      ? createElement("div", {
          "aria-label": "remote-dialog",
          role: "dialog",
        })
      : null,
}));

beforeAll(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: {
      configurable: true,
      value: () => false,
    },
    releasePointerCapture: {
      configurable: true,
      value: () => {},
    },
    scrollIntoView: {
      configurable: true,
      value: () => {},
    },
    setPointerCapture: {
      configurable: true,
      value: () => {},
    },
  });
});

afterEach(() => {
  cleanup();
});

describe("ChatEmptyWorkspacePreviewMenu remote dialog interaction", () => {
  it("打开远程连接弹窗时关闭工作区菜单", async () => {
    const { ChatEmptyWorkspacePreviewMenu } = await import(
      "../src/ChatEmptyState.js"
    );

    render(
      createElement(ChatEmptyWorkspacePreviewMenu, {
        workspacePath: "/Users/tester/project",
        workspaceTabs: [
          {
            workspacePath: "/Users/tester/project",
            label: "project",
          },
        ],
        onSelectWorkspace: vi.fn(),
        onSelectConversationWorkspace: vi.fn(),
        onOpenFolder: vi.fn(),
        onConnectRemote: vi.fn(async () => "session-id"),
        onSelectRemoteProject: vi.fn(async () => {}),
        onCancelRemoteProject: vi.fn(async () => {}),
      }),
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "chat.empty.workspaceMenu" }),
      {
        button: 0,
        ctrlKey: false,
      },
    );
    const remoteEntry = await screen.findByText("remote.trigger");

    fireEvent.click(remoteEntry);

    expect(document.querySelector('[role="dialog"][aria-label="remote-dialog"]')).not.toBeNull();
    await waitFor(() => {
      expect(screen.queryByText("workspace.openFolder")).toBeNull();
    });
  });
});
