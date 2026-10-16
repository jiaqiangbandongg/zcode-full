import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("side pane toggle empty state", () => {
  it("keeps the header toggle free of implicit tab creation fallbacks", () => {
    const source = readSource("packages/ui/src/App.tsx");
    const start = source.indexOf("const handleToggleSidePane = useCallback");
    const end = source.indexOf("const runVisibleWorkspaceCommand", start);
    const toggleSource = source.slice(start, end);

    expect(toggleSource).toContain("handleToggleSidePaneCollapse();");
    expect(toggleSource).not.toContain("handleToggleBrowser(");
    expect(toggleSource).not.toContain("handleToggleGit(");
    expect(toggleSource).not.toContain("handleOpenGit(");
  });

  it("renders an Open tab launcher when the side pane has no tabs", () => {
    const source = readSource("packages/ui/src/app-shell/AnimatedSidePanePanel.tsx");
    const styles = readSource("packages/ui/src/styles.css");

    expect(source).toContain('id: "terminal"');
    expect(source).toContain('id: "browser"');
    expect(source).toContain('id: "review"');
    expect(source).toContain('id: "selection-side-conversation"');
    expect(source).toContain('data-side-pane-add-item="selection-side-conversation"');
    expect(source).toContain("data-side-pane-open-tab-item={item.id}");
    expect(source).toContain('id: "sidePane.openTab"');
    expect(source).toContain('id: "sidePane.openTabDescription"');
    expect(source).toContain("hasRenderedSidePane ? (");
    expect(source).toContain("visibleTabs.length === 0 ? openTabLauncher : null");
    // 截图 surface prepare 期间，即使当前对话没有可见 tab，也要保留后台 browser-use
    // 的实际布局，不能回退为 display:none。
    expect(source).toContain('visibleTabs.length === 0 && !screenshotSurfaceRequest && "hidden"');
    expect(source).toContain("保留 TabsContent 挂载");
    expect(source).toContain("openTabLauncher");
    expect(source).toContain("flex-1 items-center justify-center");
    expect(source).toContain("side-pane-open-tab-shell");
    expect(source).toContain("side-pane-open-tab-list");
    expect(styles).toContain("container: side-pane-open-tab / inline-size");
    expect(styles).toContain("@container side-pane-open-tab (min-width: 480px)");
    expect(styles).toContain("grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr))");
    expect(styles).toContain("flex-direction: column");
    expect(styles).toContain("height: 5.5rem");
    expect(styles).toContain("text-align: center");
    expect(source).toContain("rounded-xl");
    expect(source).toContain("bg-surface");
    expect(source).toContain("hover:bg-surface-hover");
    expect(source).not.toContain("border border-card-border bg-card");
    expect(source).toContain("text-ui-base");
    expect(source).toContain("size-4 text-foreground-subtle");
    expect(source).not.toContain(
      '<div className="flex h-12 shrink-0 items-center justify-end border-b border-border px-3">',
    );
  });

  it("collapses the side pane after closing the final tab", () => {
    const source = readSource("packages/ui/src/hooks/useAppPanels.ts");
    const syncStart = source.indexOf("const syncSidePaneCollapsedWithTabs = useCallback");
    const syncEnd = source.indexOf("const handleOpenCodeViewer", syncStart);
    const syncSource = source.slice(syncStart, syncEnd);

    expect(syncStart).toBeGreaterThanOrEqual(0);
    expect(syncSource).not.toContain("setIsSidePaneCollapsed(false);");
    expect(syncSource).toContain("setIsSidePaneCollapsed(true);");

    const closeTabStart = source.indexOf("const handleCloseSidePaneTab = useCallback");
    const closeOtherTabStart = source.indexOf(
      "const handleCloseOtherSidePaneTabs = useCallback",
      closeTabStart,
    );
    const closeTabSource = source.slice(closeTabStart, closeOtherTabStart);

    expect(closeTabSource).toContain("const next = commitSidePaneState((current) =>");
    expect(closeTabSource).toContain("closeSidePaneTabForParent(");
    expect(closeTabSource).toContain("syncSidePaneCollapsedWithTabs(next);");

    const closeAllStart = source.indexOf("const handleCloseAllSidePaneTabs = useCallback");
    const reopenStart = source.indexOf("const handleReopenClosedSidePaneTab = useCallback");
    const closeAllSource = source.slice(closeAllStart, reopenStart);

    expect(closeAllSource).toContain("const next = closeVisibleSidePaneTabs(");
    expect(closeAllSource).toContain("syncSidePaneCollapsedWithTabs(next);");
  });

  it("截图准备不参与侧栏展开，surface 改由固定的后台承载层提供尺寸", () => {
    const source = readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");
    const sidePanePanelStart = source.indexOf(
      "} = useAnimatedResizablePanel({",
      source.indexOf("sidePanePanelRef"),
    );
    const sidePanePanelEnd = source.indexOf("const mobileSidePanePanelRef", sidePanePanelStart);
    const panelSource = source.slice(sidePanePanelStart, sidePanePanelEnd);

    expect(panelSource).toContain('open: workspaceMainView === "chat" && isSidePaneOpen');
    expect(panelSource).not.toContain("Boolean(screenshotSurfaceRequest)");

    const browserSource = readSource("packages/ui/src/browser-use/BrowserUseSidePaneContent.tsx");
    expect(browserSource).toContain('position: "fixed"');
    expect(browserSource).toContain("left: 0");
    expect(browserSource).toContain("viewport.height + 48");
  });

  it("switching conversation scope applies the resolved active tab and collapsed state together", () => {
    const source = readSource("packages/ui/src/hooks/useAppPanels.ts");
    const start = source.indexOf("const scopeKey =");
    const end = source.indexOf("const handleOpenCodeViewer", start);
    const scopeSyncSource = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(scopeSyncSource).toContain("resolveSidePaneScopeState(");
    expect(scopeSyncSource).toContain("setIsSidePaneCollapsed(resolved.isSidePaneCollapsed);");
    expect(scopeSyncSource).toContain("return resolved.sidePaneState;");
  });

  it("BrowserViewReady 只在 origin session 仍 active 时展开并激活", () => {
    const source = readSource("packages/ui/src/hooks/useAppPanels.ts");
    const start = source.indexOf("const handleBrowserViewReady = useCallback");
    const end = source.indexOf("useEffect(() =>", start);
    const handlerSource = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(handlerSource).toContain("revealSidePaneForCurrentOwner();");
    expect(handlerSource).toContain("applyBrowserUseSidePaneEvent(");
    expect(handlerSource).toContain("ownerTaskId: sidePaneOwnerIdRef.current");
    expect(handlerSource).toContain("if (result.shouldReveal)");
    expect(handlerSource).toContain('result.shouldReveal ? "展开并激活" : "后台挂载"');
  });
});
