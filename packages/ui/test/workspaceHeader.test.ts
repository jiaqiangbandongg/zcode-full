import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

vi.mock("@/WorkspaceHeaderSections.js", () => ({
  WorkspaceHeaderTitleSection: () =>
    createElement("div", {
      "data-testid": "workspace-header-title",
    }),
  WorkspaceHeaderActionSection: (props: Record<string, unknown>) =>
    createElement("div", {
      "data-header-variant": props.variant,
      "data-window-controls": Boolean(props.showWindowControls),
      "data-caption-spacing": Boolean(props.useWindowsCaptionSpacing),
      "data-summary-panel-toggle-prop": "showSummaryPanelToggle" in props ? "present" : "absent",
      "data-summary-panel-variant-prop": "summaryPanelVariant" in props ? "present" : "absent",
    }),
}));

vi.mock("@/WindowsCaptionMenuButton.js", () => ({
  WindowsCaptionMenuButton: () => createElement("div", { "data-testid": "windows-caption-menu" }),
}));

describe("WorkspaceHeader", () => {
  async function renderWorkspaceHeader(
    overrides: Partial<ComponentProps<typeof import("@/WorkspaceHeader.js").WorkspaceHeader>>,
  ) {
    const { WorkspaceHeader } = await import("@/WorkspaceHeader.js");
    return renderToStaticMarkup(
      createElement(WorkspaceHeader, {
        workspaceAbsPath: "/workspace",
        projectName: "workspace",
        activeTaskTitle: "Task",
        hasUpdateReady: false,
        activeTaskId: "task-1",
        activeTraceId: "trace-1",
        activeSessionId: "session-1",
        activeTaskProvider: "codex",
        sessionLogPath: null,
        nativeSessionLogProvider: null,
        nativeSessionLogPath: null,
        nativeSessionLogExists: false,
        nativeSessionLogLoading: false,
        providerWorkspaceConfigPath: null,
        providerWorkspaceConfigExists: false,
        providerWorkspaceConfigLoading: false,
        workspaceHeaderState: { selectedProvider: "codex" },
        gitSummary: { isRepository: false },
        gitDirtyFileCount: 0,
        isSidebarVisible: true,
        isTerminalOpen: false,
        isSidePaneOpen: false,
        summaryPanelVariant: "mini",
        onRefreshGit: vi.fn(),
        onToggleTerminal: vi.fn(),
        onToggleBrowser: vi.fn(),
        onToggleSidePane: vi.fn(),
        onReloadSession: vi.fn(),
        onCreateTask: vi.fn(),
        onOpenWorkspace: vi.fn(),
        ...overrides,
      }),
    );
  }

  it("releases native control spacing when the side pane owns the right edge", async () => {
    const html = await renderWorkspaceHeader({ isDesktop: true, isWindowsDesktop: true, reserveWindowControls: false });
    expect(html).not.toContain("padding-right:");
    expect(html).not.toContain("pr-0");
    expect(html).toContain("p-2");
    const linux = await renderWorkspaceHeader({ isDesktop: true, isMacDesktop: false, isWindowsDesktop: false, reserveWindowControls: false });
    expect(linux).not.toContain("pr-[120px]");
  });

  it("does not pass status panel toggle props to the workspace header actions", async () => {
    const html = await renderWorkspaceHeader({
      activeTaskId: "task-1",
      summaryPanelVariant: null,
    });

    expect(html).toContain('data-summary-panel-toggle-prop="absent"');
    expect(html).toContain('data-summary-panel-variant-prop="absent"');
  });

  it("uses the task variant by default and forwards it to the title section", async () => {
    const html = await renderWorkspaceHeader({});

    expect(html).toContain('data-workspace-header-variant="task"');
    expect(html).toContain('data-header-variant="task"');
  });

  it("keeps the same header skeleton for a draft variant", async () => {
    const html = await renderWorkspaceHeader({
      variant: "draft",
      activeTaskId: null,
      activeTaskTitle: "New task",
    });

    expect(html).toContain('data-workspace-header-variant="draft"');
    expect(html).toContain('data-header-variant="draft"');
    expect(html).not.toContain('data-testid="workspace-header-title"');
    expect(html).toContain("border-transparent");
    expect(html).not.toContain("border-border");
    expect(html).toContain('data-summary-panel-toggle-prop="absent"');
  });

  it("keeps the draft separator transparent while the side pane is open", async () => {
    const html = await renderWorkspaceHeader({
      variant: "draft",
      activeTaskId: null,
      activeTaskTitle: "New task",
      isSidePaneOpen: true,
    });

    expect(html).not.toContain("border-border");
    expect(html).toContain("border-transparent");
  });

  it.each([
    ["Windows", true],
    ["Linux", false],
  ])("applies the platform caption menu policy in the draft header on %s", async (_platform, isWindowsDesktop) => {
    const html = await renderWorkspaceHeader({
      variant: "draft",
      activeTaskId: null,
      activeTaskTitle: "New task",
      isDesktop: true,
      isMacDesktop: false,
      isWindowsDesktop,
    });

    expect(html).not.toContain('data-testid="windows-caption-menu"');
    expect(html).toContain('data-window-controls="true"');
    expect(html).not.toContain('data-testid="workspace-header-title"');
  });

  it("uses inline Linux controls without legacy caption spacing", async () => {
    const html = await renderWorkspaceHeader({
      isDesktop: true,
      isMacDesktop: false,
      isWindowsDesktop: false,
    });

    // Linux 现在与 Windows 一样通过 Header 操作组承载窗控，旧悬浮层及占位必须移除。
    expect(html).not.toContain("pr-[120px]");
    expect(html).not.toContain('data-testid="windows-caption-menu"');
    expect(html).toContain('data-window-controls="true"');
    expect(html).not.toContain('data-testid="linux-window-controls"');
  });

  it("limits titlebar padding animation to padding only", async () => {
    const html = await renderWorkspaceHeader({
      isDesktop: true,
      isMacDesktop: true,
      isMacFullscreen: false,
    });

    expect(html).toContain("transition-[padding]");
    expect(html).not.toContain("transition-padding");
  });

  it("uses the actual Windows titlebar geometry with the platform metric as fallback", async () => {
    const html = await renderWorkspaceHeader({
      isDesktop: true,
      isMacDesktop: false,
      isWindowsDesktop: true,
      windowsWindowControlsRightPaddingPx: 181,
    });

    // Bugfix: zoom / DPI 下不能只把推算的 inset 写死到 padding，否则下拉按钮会压住最小化。
    expect(html).not.toContain("padding-right:");

    expect(html).toContain('data-caption-spacing="false"');

  });
});
