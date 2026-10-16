// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import { clearTaskSidePaneMemoryStateForTest } from "@/lib/taskSidePaneMemory.js";

const mode = vi.hoisted(() => ({ general: false }));
vi.mock("@/hooks/useInterfaceMode.js", () => ({ useIsOfficeMode: () => mode.general }));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ zcodeSessionService: { closeSession: vi.fn(async () => {}) } }),
}));

function renderPanels() {
  return renderHook(() =>
    useAppPanels({
      workspaceAbsPath: "/repo",
      workspaceIdentity: "ssh://mode-test/repo",
      workspaceRemoteSessionId: "remote-mode-test",
      activeTaskId: "mode-task",
      sidePaneOwnerId: "mode-task",
      isDesktop: true,
      isWorkspaceVisible: true,
      supportsEmbeddedBrowser: true,
      defaultWhiteboardNamePrefix: "Whiteboard",
    }),
  );
}

describe("模式切换不改写已打开面板", () => {
  beforeEach(() => {
    mode.general = false;
    clearTaskSidePaneMemoryStateForTest();
  });
  afterEach(() => clearTaskSidePaneMemoryStateForTest());

  it("保留终端、审查、活动标签和折叠状态，同时禁止新建", () => {
    const { result, rerender, unmount } = renderPanels();
    act(() => result.current.handleOpenGit());
    act(() => result.current.handleOpenTerminalTab());
    act(() => result.current.handleToggleTerminal());
    const before = result.current.sidePaneState;
    const collapsed = result.current.isSidePaneCollapsed;
    expect(before?.tabs.map((tab) => tab.type)).toEqual(["git", "terminal"]);
    expect(result.current.isTerminalOpen).toBe(true);
    mode.general = true;
    rerender();
    expect(result.current.sidePaneState).toEqual(before);
    expect(result.current.isTerminalOpen).toBe(true);
    expect(result.current.isSidePaneCollapsed).toBe(collapsed);
    act(() => result.current.handleOpenTerminalTab());
    expect(result.current.sidePaneState).toEqual(before);
    act(() => result.current.handleToggleTerminal());
    expect(result.current.isTerminalOpen).toBe(false);
    act(() => result.current.handleToggleTerminal());
    expect(result.current.isTerminalOpen).toBe(false);
    mode.general = false;
    rerender();
    expect(result.current.sidePaneState).toEqual(before);
    unmount();
  });

  it("通用模式关闭已有标签后不能通过最近关闭入口恢复审查或终端", async () => {
    const { result, rerender, unmount } = renderPanels();
    act(() => result.current.handleOpenGit());
    const gitId = result.current.sidePaneState!.activeTabId;
    mode.general = true;
    rerender();
    await act(async () => result.current.handleCloseSidePaneTab(gitId));
    expect(result.current.sidePaneState?.tabs ?? []).toEqual([]);
    expect(result.current.recentClosedSidePaneTabs).toEqual([]);
    act(() => result.current.handleReopenClosedSidePaneTab(gitId));
    act(() => result.current.handleOpenGit());
    expect(result.current.sidePaneState?.tabs ?? []).toEqual([]);
    mode.general = false;
    rerender();
    expect(result.current.recentClosedSidePaneTabs.map((item) => item.tab.id)).toContain(gitId);
    act(() => result.current.handleReopenClosedSidePaneTab(gitId));
    expect(result.current.sidePaneState?.activeTabId).toBe(gitId);
    unmount();
  });
});
