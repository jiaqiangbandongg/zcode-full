import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebRemoteControlMobileShell,
  isWebRemoteControlMobileChatHistoryState,
} from "@/WebRemoteControlMobileShell.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (
    selector: (state: { theme: string; setTheme: (theme: string) => void }) => unknown,
  ) => selector({ theme: "dark", setTheme: vi.fn() }),
}));

vi.mock("@/components/ui/resizable.js", () => ({
  ResizablePanelGroup: ({
    children,
    className,
    layoutId,
  }: {
    children: ReactNode;
    className?: string;
    layoutId: string;
  }) =>
    createElement(
      "div",
      {
        className,
        "data-layout-id": layoutId,
      },
      children,
    ),
}));

function renderMobileShell(initialNavigationIntent?: "chat") {
  return renderToStaticMarkup(
    createElement(WebRemoteControlMobileShell, {
      activeTaskId: "task-1",
      activeWorkspacePath: "/workspace/app",
      chatContent: createElement("main", { "data-testid": "chat-content" }),
      initialNavigationIntent,
      renderTaskHome: () => createElement("aside", { "data-testid": "project-home" }),
      renderChatHeader: () => createElement("header", { "data-testid": "chat-header" }),
      switcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace: vi.fn(async () => {}),
      },
    }),
  );
}

function renderMobileShellWithSidePane(isSidePaneOpen: boolean, chatOverlay?: ReactNode) {
  return renderToStaticMarkup(
    createElement(WebRemoteControlMobileShell, {
      activeTaskId: "task-1",
      activeWorkspacePath: "/workspace/app",
      chatContent: createElement("main", { "data-testid": "chat-content" }),
      chatOverlay,
      initialNavigationIntent: "chat",
      isSidePaneOpen,
      onCloseSidePane: vi.fn(),
      renderTaskHome: () => createElement("aside", { "data-testid": "project-home" }),
      renderChatHeader: () => createElement("header", { "data-testid": "chat-header" }),
      sidePaneContent: createElement("section", { "data-testid": "side-pane-content" }),
      switcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace: vi.fn(async () => {}),
      },
    }),
  );
}

function renderMobileShellWithTransportState(terminalTransportState: "paired" | "reconnecting") {
  return renderToStaticMarkup(
    createElement(WebRemoteControlMobileShell, {
      activeTaskId: "task-1",
      activeWorkspacePath: "/workspace/app",
      chatContent: createElement("main", { "data-testid": "chat-content" }),
      initialNavigationIntent: "chat",
      renderTaskHome: () => createElement("aside", { "data-testid": "project-home" }),
      renderChatHeader: () => createElement("header", { "data-testid": "chat-header" }),
      switcher: {
        listWorkspaces: vi.fn(async () => ({ workspaces: [] })),
        switchWorkspace: vi.fn(async () => {}),
      },
      webRemoteControlTerminalTransportState: terminalTransportState,
    }),
  );
}

describe("WebRemoteControlMobileShell", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps scan bootstrap on the mobile home page without a chat intent", () => {
    const html = renderMobileShell();

    expect(html).toContain('data-testid="project-home"');
    expect(html).not.toContain('data-mobile-page="chat"');
    expect(html).not.toContain('data-testid="chat-content"');
  });

  it("starts on chat when a cross-workspace click provides a chat intent", () => {
    const html = renderMobileShell("chat");

    expect(html).toContain('data-mobile-page="chat"');
    expect(html).toContain('data-testid="chat-content"');
  });

  it("renders a theme menu trigger in the mobile chat header", () => {
    const html = renderMobileShell("chat");

    expect(html).toContain("webRemoteControl.themeMenu.trigger");
  });

  it("restores chat from browser history state after refreshing on the chat page", () => {
    vi.stubGlobal("window", {
      history: {
        state: { zcodeMobilePage: "chat" },
        back: vi.fn(),
        pushState: vi.fn(),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const html = renderMobileShell();

    expect(html).toContain('data-mobile-page="chat"');
    expect(html).toContain('data-testid="chat-content"');
  });

  it("renders side pane content as a right-side overlay over the mobile chat page", () => {
    const html = renderMobileShellWithSidePane(true);

    expect(html).toContain('data-mobile-side-pane-overlay="true"');
    expect(html).toContain("translate-x-0");
    expect(html).toContain('data-testid="side-pane-content"');
  });

  it("removes the covered chat surface from interaction while the mobile side pane is open", () => {
    const openHtml = renderMobileShellWithSidePane(true);
    const closedHtml = renderMobileShellWithSidePane(false);

    expect(openHtml).toContain('data-mobile-chat-surface="inert"');
    expect(openHtml).toContain('aria-hidden="true"');
    expect(openHtml).toContain('inert=""');
    expect(closedHtml).not.toContain('data-mobile-chat-surface="inert"');
  });

  it("keeps the chat overlay outside the inert surface while the side pane is open", () => {
    const html = renderMobileShellWithSidePane(
      true,
      createElement(
        "div",
        { "data-testid": "task-find-overlay" },
        createElement("input", { placeholder: "Search file changes..." }),
      ),
    );
    const inertSurfaceContent = html.match(/<main[^>]*inert=""[^>]*>([\s\S]*?)<\/main>/)?.[1];

    expect(html).toContain('data-mobile-chat-overlay="true"');
    expect(html).toContain("pointer-events-none absolute inset-0 z-40");
    expect(html).toContain('data-testid="task-find-overlay"');
    expect(inertSurfaceContent).toBeDefined();
    expect(inertSurfaceContent).not.toContain('data-testid="task-find-overlay"');
    expect(html.indexOf('data-mobile-chat-overlay="true"')).toBeGreaterThan(
      html.indexOf('inert=""'),
    );
  });

  it("shows a compact reconnecting notice over the existing mobile UI", () => {
    const html = renderMobileShellWithTransportState("reconnecting");

    expect(html).toContain('data-web-remote-control-reconnect-notice="true"');
    expect(html).toContain("webRemoteControl.mobileShell.reconnecting");
    expect(html).toContain('data-testid="chat-content"');
  });

  it("does not show the reconnecting notice while the transport is paired", () => {
    const html = renderMobileShellWithTransportState("paired");

    expect(html).not.toContain('data-web-remote-control-reconnect-notice="true"');
  });

  it("recognizes only the mobile chat browser history state", () => {
    expect(isWebRemoteControlMobileChatHistoryState({ zcodeMobilePage: "chat" })).toBe(true);
    expect(isWebRemoteControlMobileChatHistoryState({ zcodeMobilePage: "home" })).toBe(false);
    expect(isWebRemoteControlMobileChatHistoryState(null)).toBe(false);
  });
});
