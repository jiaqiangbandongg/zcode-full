import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readUiSource(relativePath: string): string {
  return readFileSync(
    new URL(`../src/${relativePath}`, import.meta.url),
    "utf8",
  );
}

describe("workspace sidebar new-task routing", () => {
  it("叶子 workspace row 只上报新建意图，不直接操作 session store", () => {
    const source = readUiSource("WorkspaceSidebarItem.tsx");

    expect(source).toContain("onStartDraftInWorkspace(");
    expect(source).not.toMatch(/const\s+startDraft\s*=\s*useZCodeSessionStore/);
  });

  it("桌面端统一新建路径先退出 group/split pane，再创建显式草稿", () => {
    const source = readUiSource("App.tsx");
    const deactivateIndex = source.indexOf(
      "useWorkbenchGroupStore.getState().deactivateActiveGroup()",
    );
    const resetPaneIndex = source.indexOf(
      "usePaneLayoutStore.getState().resetToPrimaryPane()",
    );
    const startDraftIndex = source.indexOf(
      "store.startDraft(",
      deactivateIndex,
    );

    expect(deactivateIndex).toBeGreaterThan(-1);
    expect(resetPaneIndex).toBeGreaterThan(deactivateIndex);
    expect(startDraftIndex).toBeGreaterThan(resetPaneIndex);
  });

  it("workspace 行展开复用草稿导航事务，不直接恢复 tab 的旧 session", () => {
    const source = readUiSource("WorkspaceSidebarItem.tsx");
    const openChangeStart = source.indexOf("const handleWorkspaceOpenChange");
    const openChangeEnd = source.indexOf("const handleSelectTask", openChangeStart);
    const openChangeSource = source.slice(openChangeStart, openChangeEnd);

    expect(openChangeSource).toContain("onStartDraftInWorkspace(");
    expect(openChangeSource).not.toContain("activateTab(tab.id)");
  });

  it("本地 workspace 打开后进入草稿，而不是沿用旧 active session", () => {
    const source = readUiSource("root/useRootWorkspaceActions.ts");
    const selectProjectStart = source.indexOf("const handleSelectProject");
    const selectProjectEnd = source.indexOf("const handleOpenWorkspace", selectProjectStart);
    const selectProjectSource = source.slice(selectProjectStart, selectProjectEnd);
    const addTabIndex = selectProjectSource.indexOf("addTab(path)");
    const startDraftIndex = selectProjectSource.indexOf("startDraftInWorkspace(path)");

    expect(addTabIndex).toBeGreaterThan(-1);
    expect(startDraftIndex).toBeGreaterThan(addTabIndex);
  });

  it("冷启动 workspace 进入草稿，但显式 taskId 保持 session 导航优先", () => {
    const source = readUiSource("root/useRootPlatformEffects.ts");
    const initialWorkspaceStart = source.indexOf("if (initialWorkspaceAbsPath)");
    const initialWorkspaceEnd = source.indexOf(
      "setIsBootstrappingInitialWorkspace(false)",
      initialWorkspaceStart,
    );
    const initialWorkspaceSource = source.slice(initialWorkspaceStart, initialWorkspaceEnd);
    const explicitTaskIndex = initialWorkspaceSource.indexOf("if (initialTaskId)");
    const coldDraftIndex = initialWorkspaceSource.indexOf(
      "else if (!isRendererReloadNavigation())",
    );
    const startDraftIndex = initialWorkspaceSource.indexOf("startDraftInWorkspace(");

    expect(explicitTaskIndex).toBeGreaterThan(-1);
    expect(coldDraftIndex).toBeGreaterThan(explicitTaskIndex);
    expect(startDraftIndex).toBeGreaterThan(coldDraftIndex);
  });

  it("远程 workspace 选定 canonical identity 后进入对应草稿桶", () => {
    const source = readUiSource("Root.tsx");
    const remoteDraftStart = source.indexOf("const handleRemoteWorkspaceActivated");
    const remoteDraftEnd = source.indexOf("});", remoteDraftStart);
    const remoteDraftSource = source.slice(remoteDraftStart, remoteDraftEnd);

    expect(remoteDraftSource).toContain(
      "startDraftInWorkspace(workspacePath, workspaceIdentity)",
    );
  });
});
