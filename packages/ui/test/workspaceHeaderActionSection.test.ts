import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { WorkspaceHeaderActionSection as WorkspaceHeaderActionSectionType } from "@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { createSettingsTestServices } from "./lib/settingsTestServices.js";

const capturedHeaderHelp = vi.hoisted(() => {
  const screenshot = {
    dataBase64: "base64-image",
    filename: "zcode-error-2026-06-17.png",
    contentType: "image/png",
    size: 12,
  };

  return {
    screenshot,
    openCommunity: vi.fn(),
    openExternal: vi.fn(),
    exportLogs: vi.fn(async () => ({ success: true })),
    captureWindowScreenshot: vi.fn(async () => screenshot),
    openSubmit: vi.fn(),
    openFeatureRequest: vi.fn(),
    menuItems: [] as Array<{
      onSelect: (() => void | Promise<void>) | undefined;
    }>,
    editorButtonProps: [] as Array<Record<string, unknown>>,
  };
});

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/WorkspaceEditorButtonGroup.js", () => ({
  WorkspaceEditorButtonGroup: (props: Record<string, unknown>) => {
    capturedHeaderHelp.editorButtonProps.push(props);
    return createElement("div", { "data-testid": "workspace-editor-buttons" });
  },
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "dropdown-menu" }, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", { "data-testid": "dropdown-content" }, children),
  // 桌面端帮助菜单在「资源管理器」项前有一条分隔线，mock 必须导出否则 SSR 渲染直接抛错。
  DropdownMenuSeparator: () => createElement("hr"),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: () => void | Promise<void>;
  }) => {
    capturedHeaderHelp.menuItems.push({ onSelect });
    return createElement("button", { type: "button" }, children);
  },
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    exportLogs: capturedHeaderHelp.exportLogs,
    captureWindowScreenshot: capturedHeaderHelp.captureWindowScreenshot,
    openCommunity: capturedHeaderHelp.openCommunity,
    openExternal: capturedHeaderHelp.openExternal,
  }),
}));

vi.mock("@/components/ui/toast.js", () => ({
  dismissToast: vi.fn(),
  toast: vi.fn(() => 1),
}));

vi.mock("@/feedback/feedbackStore.js", () => ({
  useFeedbackStore: (
    selector: (state: {
      openSubmit: (draft?: unknown) => void;
      openFeatureRequest: () => void;
    }) => unknown,
  ) =>
    selector({
      openSubmit: capturedHeaderHelp.openSubmit,
      openFeatureRequest: capturedHeaderHelp.openFeatureRequest,
    }),
}));

describe("WorkspaceHeaderActionSection", () => {
  // 快捷键特性后组件经 useShortcutCommandLabel 读设置，裸渲染需提供最小 ServiceProvider。
  // 等形包装：withSettingsServices(Comp, props) ≡ createElement(ServiceProvider, …, createElement(Comp, props))。
  function withSettingsServices(
    Component: typeof WorkspaceHeaderActionSectionType,
    props: Parameters<typeof WorkspaceHeaderActionSectionType>[0],
  ): ReactNode {
    return createElement(
      ServiceProvider,
      { services: createSettingsTestServices() },
      createElement(Component, props),
    );
  }

  // staging 新增用例：同样需要 Provider 包装（组件在快捷键特性后读设置）
  it("leaves the collapse action to the open side pane header", async () => {
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");
    const html = renderToStaticMarkup(
      withSettingsServices(WorkspaceHeaderActionSection, {
        workspaceAbsPath: "/workspace",
        isTerminalOpen: false,
        isSidePaneOpen: true,
        onToggleTerminal: vi.fn(),
        onToggleSidePane: vi.fn(),
      }),
    );
    expect(html).not.toContain("sidePane.collapse");
    expect(html).not.toContain("sidePane.expand");
  });

  it("hides the editor selector but keeps shared actions in the draft variant", async () => {
    capturedHeaderHelp.editorButtonProps = [];
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");

    const html = renderToStaticMarkup(
      withSettingsServices(WorkspaceHeaderActionSection, {
        variant: "draft",
        workspaceAbsPath: "/workspace",
        isTerminalOpen: false,
        isSidePaneOpen: false,
        onToggleTerminal: vi.fn(),
        onToggleSidePane: vi.fn(),
      }),
    );

    expect(capturedHeaderHelp.editorButtonProps).toHaveLength(0);
    expect(html).not.toContain('data-testid="workspace-editor-buttons"');
    expect(html).toContain("workspaceHeader.help.menu");
    expect(html).toContain("terminal.toggle");
    expect(html).toContain("sidePane.expand");
  });

  it("只在 Desktop local/SSH/WSL/Docker 已有任务显示分享入口", async () => {
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");
    const renderSection = (extra: Record<string, unknown>) =>
      renderToStaticMarkup(
        withSettingsServices(WorkspaceHeaderActionSection, {
          activeTaskId: "task-1",
          workspaceAbsPath: "/workspace",
          isTerminalOpen: false,
          isSidePaneOpen: false,
          onToggleTerminal: vi.fn(),
          onToggleSidePane: vi.fn(),
          isDesktop: true,
          user: { id: "user-1" },
          ...extra,
        }),
      );

    expect(renderSection({})).toContain("conversationShare.trigger");
    expect(renderSection({ remoteTarget: { kind: "ssh" } })).toContain("conversationShare.trigger");
    expect(renderSection({ isWebRemoteControl: true })).not.toContain("conversationShare.trigger");
    expect(renderSection({ remoteTarget: { kind: "server" } })).not.toContain(
      "conversationShare.trigger",
    );
  });

  it("未登录时不展示分享入口", async () => {
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");

    const html = renderToStaticMarkup(
      withSettingsServices(WorkspaceHeaderActionSection, {
        activeTaskId: "task-1",
        workspaceAbsPath: "/workspace",
        isTerminalOpen: false,
        isSidePaneOpen: false,
        onToggleTerminal: vi.fn(),
        onToggleSidePane: vi.fn(),
        isDesktop: true,
        user: null,
      }),
    );

    expect(html).not.toContain("conversationShare.trigger");
  });

  it("renders the help menu trigger before the terminal toggle", async () => {
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");

    const html = renderToStaticMarkup(
      withSettingsServices(WorkspaceHeaderActionSection, {
        workspaceAbsPath: "/workspace",
        isTerminalOpen: false,
        isSidePaneOpen: false,
        onToggleTerminal: vi.fn(),
        onToggleSidePane: vi.fn(),
      }),
    );

    expect(html).not.toContain("chat.summaryPanel.toggle");
    expect(html).toContain("workspaceHeader.help.menu");
    expect(html).toContain("workspaceHeader.help.issueReport");
    expect(html).toContain("workspaceHeader.help.productRequest");
    expect(html).toContain("workspaceHeader.help.community");
    expect(html).toContain("workspaceHeader.help.docs");
    expect(html).not.toContain("titleBar.menu.help.exportLogs");
    expect(html).toContain("terminal.toggle");
    expect(html).toContain("sidePane.expand");
    expect(html.indexOf("workspaceHeader.help.menu")).toBeLessThan(html.indexOf("terminal.toggle"));
  });

  it("hides the help menu and terminal toggle in narrow remote mode", async () => {
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");

    const html = renderToStaticMarkup(
      withSettingsServices(WorkspaceHeaderActionSection, {
        workspaceAbsPath: "/workspace",
        isTerminalOpen: false,
        isSidePaneOpen: false,
        onToggleTerminal: vi.fn(),
        onToggleSidePane: vi.fn(),
        simplifyForNarrowRemote: true,
      }),
    );

    expect(html).not.toContain("workspaceHeader.help.menu");
    expect(html).not.toContain("workspaceHeader.help.issueReport");
    expect(html).not.toContain("terminal.toggle");
    expect(html).toContain("sidePane.expand");
  });

  it("hides only the help menu when Windows caption menu owns help actions", async () => {
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");

    const html = renderToStaticMarkup(
      withSettingsServices(WorkspaceHeaderActionSection, {
        workspaceAbsPath: "/workspace",
        isTerminalOpen: false,
        isSidePaneOpen: false,
        onToggleTerminal: vi.fn(),
        onToggleSidePane: vi.fn(),
        hideHelpMenu: true,
      }),
    );

    expect(html).not.toContain("workspaceHeader.help.menu");
    expect(html).not.toContain("workspaceHeader.help.issueReport");
    expect(html).toContain("terminal.toggle");
    expect(html).toContain("sidePane.expand");
  });

  it("routes help menu items to feedback, community, and docs entries", async () => {
    capturedHeaderHelp.menuItems = [];
    capturedHeaderHelp.openSubmit.mockClear();
    capturedHeaderHelp.openFeatureRequest.mockClear();
    capturedHeaderHelp.openCommunity.mockClear();
    capturedHeaderHelp.openExternal.mockClear();
    capturedHeaderHelp.exportLogs.mockClear();
    capturedHeaderHelp.captureWindowScreenshot.mockClear();
    capturedHeaderHelp.captureWindowScreenshot.mockResolvedValue(capturedHeaderHelp.screenshot);
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");

    renderToStaticMarkup(
      withSettingsServices(WorkspaceHeaderActionSection, {
        workspaceAbsPath: "/workspace",
        isTerminalOpen: false,
        isSidePaneOpen: false,
        onToggleTerminal: vi.fn(),
        onToggleSidePane: vi.fn(),
      }),
    );

    expect(capturedHeaderHelp.menuItems).toHaveLength(4);
    await capturedHeaderHelp.menuItems[2]?.onSelect?.();
    capturedHeaderHelp.menuItems[1]?.onSelect?.();
    capturedHeaderHelp.menuItems[0]?.onSelect?.();
    capturedHeaderHelp.menuItems[3]?.onSelect?.();

    expect(capturedHeaderHelp.captureWindowScreenshot).not.toHaveBeenCalled();
    expect(capturedHeaderHelp.openSubmit).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "bug",
        includeLogs: true,
        screenshots: [],
      }),
    );
    expect(capturedHeaderHelp.openFeatureRequest).toHaveBeenCalledTimes(1);
    expect(capturedHeaderHelp.openCommunity).toHaveBeenCalledTimes(1);
    expect(capturedHeaderHelp.openExternal).toHaveBeenCalledWith("https://zcode.z.ai/docs");
    expect(capturedHeaderHelp.exportLogs).not.toHaveBeenCalled();
  });

  it("opens issue report without screenshots when window screenshot fails", async () => {
    capturedHeaderHelp.menuItems = [];
    capturedHeaderHelp.openSubmit.mockClear();
    capturedHeaderHelp.captureWindowScreenshot.mockReset();
    capturedHeaderHelp.captureWindowScreenshot.mockRejectedValue(new Error("capture failed"));
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");

    renderToStaticMarkup(
      withSettingsServices(WorkspaceHeaderActionSection, {
        workspaceAbsPath: "/workspace",
        isTerminalOpen: false,
        isSidePaneOpen: false,
        onToggleTerminal: vi.fn(),
        onToggleSidePane: vi.fn(),
      }),
    );

    await capturedHeaderHelp.menuItems[2]?.onSelect?.();

    expect(capturedHeaderHelp.openSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "bug",
        includeLogs: true,
        screenshots: [],
      }),
    );
  });

  it("passes SSH remote context to the editor button group", async () => {
    capturedHeaderHelp.editorButtonProps = [];
    const { WorkspaceHeaderActionSection } =
      await import("@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js");
    const remoteTarget = {
      kind: "ssh",
      host: "jumpserver.example.com",
      port: 2222,
      username: "asset01@root@192.168.100.166",
      sshConfigAlias: "zcode",
    };

    renderToStaticMarkup(
      withSettingsServices(WorkspaceHeaderActionSection, {
        workspaceAbsPath: "/root/demo-project",
        workspaceIdentity:
          "remote:ssh:jumpserver.example.com:2222:asset01@root@192.168.100.166:/root/demo-project",
        remoteTarget,
        isTerminalOpen: false,
        isSidePaneOpen: false,
        onToggleTerminal: vi.fn(),
        onToggleSidePane: vi.fn(),
      }),
    );

    expect(capturedHeaderHelp.editorButtonProps[0]).toMatchObject({
      workspaceAbsPath: "/root/demo-project",
      workspaceIdentity:
        "remote:ssh:jumpserver.example.com:2222:asset01@root@192.168.100.166:/root/demo-project",
      remoteTarget,
    });
  });
});
