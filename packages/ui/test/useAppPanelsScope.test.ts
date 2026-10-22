// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import { clearTaskSidePaneMemoryStateForTest } from "@/lib/taskSidePaneMemory.js";
import { getVisibleSidePaneTabs } from "@/lib/workspaceSidePane.js";

vi.mock("@/hooks/useInterfaceMode.js", () => ({ useIsOfficeMode: () => false }));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ zcodeSessionService: { closeSession: vi.fn(async () => {}) } }),
}));
vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const a = { workspaceIdentity: "ssh://one/repo", ownerTaskId: "a" as string | null };
const b = { ...a, ownerTaskId: "b" };
function setup() {
  const platform = { browserViewCloseTab: vi.fn(async () => {}) };
  const rendered = renderHook(
    (scope: typeof a) =>
      useAppPanels({
        workspaceAbsPath: "/repo",
        workspaceIdentity: scope.workspaceIdentity,
        activeTaskId: null,
        sidePaneOwnerId: scope.ownerTaskId,
        isDesktop: true,
        supportsEmbeddedBrowser: true,
        defaultWhiteboardNamePrefix: "Whiteboard",
        platform,
      }),
    { initialProps: a },
  );
  const open = (origin: string) => {
    act(() => rendered.result.current.handleOpenBrowserPermissionSettings(origin));
    return rendered.result.current.sidePaneState!.activeTabId;
  };
  const ids = () => rendered.result.current.sidePaneState?.tabs.map((tab) => tab.id) ?? [];
  return { ...rendered, platform, open, ids };
}

describe("侧栏显示、关闭与恢复共用工作区/对话归属", () => {
  beforeEach(clearTaskSidePaneMemoryStateForTest);
  afterEach(() => {
    cleanup();
    clearTaskSidePaneMemoryStateForTest();
  });

  it.each(["", "ssh://two/repo"])(
    "跨工作区文件请求只在目标 %s 的 owner 中创建，返回后仍可见",
    (identity) => {
      const h = setup();
      const previous = h.open("https://a.test");
      act(() =>
        h.result.current.handleOpenFileManager({
          workspacePath: "/repo",
          ...(identity
            ? { workspaceIdentity: identity, workspaceRemoteSessionId: "remote-two" }
            : {}),
        }),
      );
      expect(h.result.current.sidePaneState?.tabs.some((tab) => tab.type === "file-manager")).toBe(
        false,
      );
      const targetScope = { workspaceIdentity: identity, ownerTaskId: "target-task" };
      h.rerender(targetScope);
      const fileTab = h.result.current.sidePaneState?.tabs.find(
        (tab) => tab.type === "file-manager",
      );
      expect(fileTab).toMatchObject({
        workspaceKey: identity || "/repo",
        ownerTaskId: "target-task",
        target: { workspacePath: "/repo" },
      });
      expect(h.result.current.isSidePaneCollapsed).toBe(false);
      h.rerender(a);
      expect(h.ids()).toContain(previous);
      expect(h.ids()).not.toContain(fileTab!.id);
      h.rerender(targetScope);
      expect(h.ids()).toContain(fileTab!.id);
      expect(h.result.current.isSidePaneCollapsed).toBe(false);
    },
  );

  it.each(["all", "others"] as const)(
    "B 关闭 %s 不删除 A，最近关闭和重新打开保持原归属",
    async (mode) => {
      const h = setup();
      const aId = h.open("https://a.test");
      h.rerender(b);
      const bId = h.open("https://b.test");
      const keep = h.open("https://keep.test");
      await act(async () =>
        mode === "all"
          ? h.result.current.handleCloseAllSidePaneTabs()
          : h.result.current.handleCloseOtherSidePaneTabs(keep),
      );
      expect(h.ids()).toContain(aId);
      expect(h.ids()).not.toContain(bId);
      expect(h.result.current.recentClosedSidePaneTabs.map((item) => item.tab.id)).not.toContain(
        aId,
      );
      h.rerender(a);
      expect(h.result.current.sidePaneState?.activeTabId).toBe(aId);
      expect(h.result.current.isSidePaneCollapsed).toBe(false);
      expect(h.result.current.recentClosedSidePaneTabs).toEqual([]);
      act(() => h.result.current.handleReopenClosedSidePaneTab(bId));
      expect(h.ids()).not.toContain(bId);
      h.rerender(b);
      act(() => h.result.current.handleReopenClosedSidePaneTab(bId));
      expect(h.result.current.sidePaneState?.activeTabId).toBe(bId);
    },
  );

  it("最近关闭不跨同路径的 workspaceIdentity，返回原工作区可恢复", async () => {
    const h = setup();
    const id = h.open("https://a.test");
    await act(async () => h.result.current.handleCloseSidePaneTab(id));
    h.rerender({ ...a, workspaceIdentity: "ssh://two/repo" });
    expect(h.result.current.recentClosedSidePaneTabs).toEqual([]);
    act(() => h.result.current.handleReopenClosedSidePaneTab(id));
    expect(h.ids()).toEqual([]);
    h.rerender(a);
    act(() => h.result.current.handleReopenClosedSidePaneTab(id));
    expect(h.result.current.sidePaneState?.tabs.map((tab) => tab.type)).toEqual([
      "browser-permissions",
    ]);
    expect(h.result.current.sidePaneState?.activeTabId).toBe(id);
  });

  it("快捷入口打开的 Browser 也冻结工作区，最近关闭不泄漏到同 owner 的其他工作区", async () => {
    const h = setup();
    act(() => h.result.current.handleToggleBrowser());
    const id = h.result.current.sidePaneState!.activeTabId;
    expect(h.result.current.sidePaneState!.tabs[0]).toMatchObject({
      ownerTaskId: "a",
      workspaceKey: a.workspaceIdentity,
    });
    await act(async () => h.result.current.handleCloseSidePaneTab(id));
    h.rerender({ ...a, workspaceIdentity: "ssh://two/repo" });
    expect(h.result.current.recentClosedSidePaneTabs).toEqual([]);
    act(() => h.result.current.handleReopenClosedSidePaneTab(id));
    expect(h.ids()).toEqual([]);
  });

  it("关闭最后一个可见 tab 收起面板，隐藏 tab 保留；公共 Git 在同工作区仍可恢复", async () => {
    const h = setup();
    const aId = h.open("https://a.test");
    h.rerender(b);
    const bId = h.open("https://b.test");
    await act(async () => h.result.current.handleCloseSidePaneTab(bId));
    expect(h.ids()).toContain(aId);
    const visible = getVisibleSidePaneTabs(h.result.current.sidePaneState!.tabs, {
      workspaceKey: b.workspaceIdentity,
      ownerTaskId: b.ownerTaskId,
    });
    expect(visible).toEqual([]);
    expect(h.result.current.isSidePaneCollapsed).toBe(true);
    act(() => h.result.current.handleOpenGit());
    await act(async () => h.result.current.handleCloseSidePaneTab("git"));
    h.rerender(a);
    expect(h.result.current.recentClosedSidePaneTabs.map((item) => item.tab.id)).toEqual(["git"]);
    act(() => h.result.current.handleReopenClosedSidePaneTab("git"));
    expect(h.result.current.sidePaneState?.activeTabId).toBe("git");
  });

  it("重新进入草稿不继承历史展开偏好，显式展开恢复原标签", () => {
    const h = setup();
    h.rerender({ ...a, ownerTaskId: null });
    act(() => h.result.current.handleToggleSidePaneCollapse());
    const draftId = h.result.current.sidePaneState!.activeTabId;
    h.rerender(a);
    expect(h.result.current.isSidePaneCollapsed).toBe(true);
    h.rerender({ ...a, ownerTaskId: null });
    expect(h.result.current.isSidePaneCollapsed).toBe(true);
    act(() => h.result.current.handleToggleSidePaneCollapse());
    expect(h.result.current.sidePaneState!.activeTabId).toBe(draftId);
  });

  it("同一 batch 的折叠写入与 toggle 读取一致", () => {
    const h = setup();
    act(() => h.result.current.handleToggleSidePaneCollapse());
    const id = h.result.current.sidePaneState!.activeTabId;
    act(() => {
      h.result.current.setIsSidePaneCollapsed(true);
      h.result.current.handleToggleSidePaneCollapse();
    });
    expect(h.result.current.isSidePaneCollapsed).toBe(false);
    expect(h.result.current.sidePaneState!.activeTabId).toBe(id);
  });

  it("null 草稿与具名草稿分开；关闭不可见 id 不产生副作用", async () => {
    const h = setup();
    const aId = h.open("https://a.test");
    h.rerender({ ...a, ownerTaskId: null });
    const draftId = h.open("https://draft.test");
    await act(async () => h.result.current.handleCloseSidePaneTab(aId));
    expect(h.ids()).toEqual([aId, draftId]);
    await act(async () => h.result.current.handleCloseAllSidePaneTabs());
    expect(h.ids()).toContain(aId);
    expect(
      getVisibleSidePaneTabs(h.result.current.sidePaneState!.tabs, {
        workspaceKey: a.workspaceIdentity,
        ownerTaskId: null,
      }),
    ).toEqual([]);
    expect(h.ids()).not.toContain(draftId);
  });

  it.each(["owner", "workspace"] as const)(
    "异步 Browser 关闭后切换 %s，只提交选中的旧 id",
    async (switchKind) => {
      const h = setup();
      let finish!: () => void;
      h.platform.browserViewCloseTab.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      act(() => h.result.current.handleOpenBrowserTab());
      const browserId = h.result.current.sidePaneState!.activeTabId;
      const oldSetting = h.open("https://old.test");
      act(() => h.result.current.handleCloseAllSidePaneTabs());
      const addedDuringClose = h.open("https://new.test");
      const nextScope = switchKind === "owner" ? b : { ...a, workspaceIdentity: "ssh://two/repo" };
      h.rerender(nextScope);
      const nextId = h.open("https://next.test");
      await act(async () => finish());
      expect(h.result.current.sidePaneState?.activeTabId).toBe(nextId);
      expect(h.result.current.isSidePaneCollapsed).toBe(false);
      expect(h.platform.browserViewCloseTab).toHaveBeenCalledTimes(1);
      expect(h.platform.browserViewCloseTab).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: browserId, workspaceKey: a.workspaceIdentity }),
      );
      h.rerender(a);
      expect(h.ids()).toContain(addedDuringClose);
      expect(h.ids()).not.toContain(oldSetting);
      expect(h.ids()).not.toContain(browserId);
      expect(
        getVisibleSidePaneTabs(h.result.current.sidePaneState!.tabs, {
          workspaceKey: a.workspaceIdentity,
          ownerTaskId: a.ownerTaskId,
        }).map((tab) => tab.id),
      ).toEqual([addedDuringClose]);
    },
  );

  it("main 拒绝关闭时保留标签与最近关闭列表", async () => {
    const h = setup();
    act(() => h.result.current.handleOpenBrowserTab());
    const before = h.result.current.sidePaneState;
    h.platform.browserViewCloseTab.mockRejectedValue(new Error("close rejected"));
    await act(async () => h.result.current.handleCloseAllSidePaneTabs());
    expect(h.result.current.sidePaneState).toBe(before);
    expect(h.result.current.recentClosedSidePaneTabs).toEqual([]);
  });
});
