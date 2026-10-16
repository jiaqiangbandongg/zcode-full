import { describe, expect, it, vi } from "vitest";
import { applyWorkspaceTriggerSelection } from "../src/WorkspaceSidebar.js";
import {
  createTabStore,
  isWorkspaceReadOnly,
  isWorkspaceTab,
  SETTINGS_TAB_ID,
} from "../src/store/tabStore.js";
import { WORKSPACE_EXPANSION_STORAGE_KEY } from "../src/lib/workspaceExpansionPreference.js";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));

  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("tabStore", () => {
  it("opens only one settings tab per window", () => {
    const store = createTabStore();

    store.getState().openSettingsTab();
    store.getState().openSettingsTab();

    const settingsTabs = store.getState().tabs.filter((tab) => tab.id === SETTINGS_TAB_ID);
    expect(settingsTabs).toHaveLength(1);
    expect(store.getState().activeTabId).toBe(SETTINGS_TAB_ID);
  });

  it("restores only workspace tabs from persisted session", () => {
    const store = createTabStore();

    store.getState().restoreTabs(["/tmp/a", "/tmp/b"], 1);

    expect(store.getState().tabs.every(isWorkspaceTab)).toBe(true);
    expect(store.getState().tabs).toHaveLength(2);
    expect(store.getState().activeTabId).toBe(store.getState().tabs[1]?.id ?? null);
  });

  it("首帧后补齐 inactive workspace 时保留 active tab identity 和焦点", () => {
    const store = createTabStore();

    store.getState().restoreTabs(["/tmp/active"], 0);
    const activeTabId = store.getState().activeTabId;
    store.getState().completeTabRestore(["/tmp/inactive-a", "/tmp/active", "/tmp/inactive-b"]);

    expect(
      store
        .getState()
        .tabs.filter(isWorkspaceTab)
        .map((tab) => tab.workspacePath),
    ).toEqual(["/tmp/inactive-a", "/tmp/active", "/tmp/inactive-b"]);
    expect(store.getState().activeTabId).toBe(activeTabId);
    expect(store.getState().activeWorkspacePath).toBe("/tmp/active");
    expect(store.getState().tabs.find((tab) => tab.id === activeTabId)).toMatchObject({
      workspacePath: "/tmp/active",
    });
  });

  it("补齐 inactive workspace 不覆盖启动后用户新开的 tab", () => {
    const store = createTabStore();

    store.getState().restoreTabs(["/tmp/active"], 0);
    const userTabId = store.getState().addTab("/tmp/user-opened");
    store.getState().completeTabRestore(["/tmp/inactive", "/tmp/active"]);

    expect(
      store
        .getState()
        .tabs.filter(isWorkspaceTab)
        .map((tab) => tab.workspacePath),
    ).toEqual(["/tmp/user-opened", "/tmp/inactive", "/tmp/active"]);
    expect(store.getState().activeTabId).toBe(userTabId);
    expect(store.getState().activeWorkspacePath).toBe("/tmp/user-opened");
  });

  it("preserves conversation purpose when adding and restoring managed workspace tabs", () => {
    const store = createTabStore();

    store.getState().addTab("/tmp/.zcode/workspace/default", {
      workspacePurpose: "conversation",
    });
    expect(store.getState().tabs[0]).toMatchObject({
      workspacePath: "/tmp/.zcode/workspace/default",
      workspacePurpose: "conversation",
    });

    store.getState().restoreTabs(
      [
        {
          workspacePath: "/tmp/.zcode/workspace/default",
          workspacePurpose: "conversation",
        },
      ],
      0,
    );
    expect(store.getState().tabs[0]).toMatchObject({
      workspacePurpose: "conversation",
    });
  });

  it("restores remote workspace metadata together with the tab", () => {
    const store = createTabStore();

    store.getState().restoreTabs(
      [
        {
          workspacePath: "/workspace/demo",
          remoteSessionId: "remote-session-1",
          workspaceIdentity: "remote:docker:demo-container:/workspace/demo",
          remoteTarget: {
            kind: "docker",
            container: "demo-container",
          },
        },
      ],
      0,
    );

    const restoredTab = store.getState().tabs[0];
    expect(restoredTab && isWorkspaceTab(restoredTab) ? restoredTab.remoteSessionId : null).toBe(
      "remote-session-1",
    );
    expect(restoredTab && isWorkspaceTab(restoredTab) ? restoredTab.workspaceIdentity : null).toBe(
      "remote:docker:demo-container:/workspace/demo",
    );
  });

  it("restores startup availability as renderer-only workspace state", () => {
    const store = createTabStore();

    store.getState().restoreTabs(
      [
        {
          workspacePath: "/workspace/missing",
          availability: "unavailable-local-directory",
        },
      ],
      0,
    );

    expect(isWorkspaceReadOnly(store.getState(), "/workspace/missing")).toBe(true);
    const restoredTab = store.getState().tabs[0];
    expect(restoredTab && isWorkspaceTab(restoredTab) ? restoredTab.availability : null).toBe(
      "unavailable-local-directory",
    );
  });

  it("reuses an existing workspace tab instead of duplicating it", () => {
    const store = createTabStore();

    const firstId = store.getState().addTab("/tmp/demo");
    const secondId = store.getState().addTab("/tmp/demo");

    expect(secondId).toBe(firstId);
    expect(store.getState().tabs.filter(isWorkspaceTab)).toHaveLength(1);
  });

  it("refreshes remote metadata when reusing an existing remote workspace tab", () => {
    const store = createTabStore();

    store.getState().addTab("/workspace/demo", {
      workspaceIdentity: "remote:docker:demo:/workspace/demo",
      remoteTarget: {
        kind: "docker",
        container: "demo",
      },
    });

    store.getState().addTab("/workspace/demo", {
      remoteSessionId: "remote-session-1",
      workspaceIdentity: "remote:docker:demo:/workspace/demo",
      remoteTarget: {
        kind: "docker",
        container: "demo",
      },
    });

    const reusedTab = store.getState().tabs.find(
      (tab) => isWorkspaceTab(tab) && tab.workspacePath === "/workspace/demo",
    );

    expect(reusedTab && isWorkspaceTab(reusedTab) ? reusedTab.remoteSessionId : null).toBe(
      "remote-session-1",
    );
    expect(reusedTab && isWorkspaceTab(reusedTab) ? reusedTab.workspaceIdentity : null).toBe(
      "remote:docker:demo:/workspace/demo",
    );
  });

  it("keeps separate tabs for same path with different remote workspace identities", () => {
    const store = createTabStore();

    const firstTabId = store.getState().addTab("/workspace/demo", {
      remoteSessionId: "remote-session-a",
      workspaceIdentity: "remote:ssh:10.0.0.1:22:dev:/workspace/demo",
      remoteTarget: {
        kind: "ssh",
        host: "10.0.0.1",
        username: "dev",
      },
    });

    const secondTabId = store.getState().addTab("/workspace/demo", {
      remoteSessionId: "remote-session-b",
      workspaceIdentity: "remote:ssh:10.0.0.2:22:dev:/workspace/demo",
      remoteTarget: {
        kind: "ssh",
        host: "10.0.0.2",
        username: "dev",
      },
    });

    expect(secondTabId).not.toBe(firstTabId);
    expect(store.getState().tabs.filter(isWorkspaceTab)).toHaveLength(2);
  });

  it("puts newly opened workspaces at the top of the list", () => {
    const store = createTabStore();

    store.getState().addTab("/tmp/a");
    store.getState().addTab("/tmp/b");
    store.getState().addTab("/tmp/c");

    expect(store.getState().tabs.filter(isWorkspaceTab).map((tab) => tab.workspacePath)).toEqual([
      "/tmp/c",
      "/tmp/b",
      "/tmp/a",
    ]);
  });

  it("keeps the current focus while making an imported workspace visible", () => {
    const store = createTabStore();
    const workspaceIdentity = "remote:ssh:10.0.0.1:22:dev:/tmp/current";

    store.getState().addTab("/tmp/current", {
      workspaceIdentity,
      remoteTarget: {
        kind: "ssh",
        host: "10.0.0.1",
        username: "dev",
      },
    });
    store.getState().openSettingsTab();

    store.getState().ensureWorkspaceTab("/tmp/imported");

    expect(store.getState().activeTabId).toBe(SETTINGS_TAB_ID);
    expect(store.getState().activeWorkspacePath).toBe("/tmp/current");
    expect(store.getState().activeWorkspaceIdentity).toBe(workspaceIdentity);
    expect(store.getState().expandedWorkspacePaths.has("/tmp/imported")).toBe(true);
    expect(store.getState().tabs.filter(isWorkspaceTab).map((tab) => tab.workspacePath)).toEqual([
      "/tmp/imported",
      "/tmp/current",
    ]);
  });

  it("preserves manual workspace collapse when switching active tabs", () => {
    const store = createTabStore();

    const firstId = store.getState().addTab("/tmp/a");
    const secondId = store.getState().addTab("/tmp/b");

    store.getState().activateTab(firstId);
    store.getState().toggleWorkspaceExpanded("/tmp/a");
    store.getState().activateTab(secondId);

    expect(store.getState().activeWorkspacePath).toBe("/tmp/b");
    expect(store.getState().expandedWorkspacePaths.has("/tmp/a")).toBe(false);
    expect(store.getState().expandedWorkspacePaths.has("/tmp/b")).toBe(true);
  });

  it("persists workspace expanded state to local storage", () => {
    const storage = createMemoryStorage();
    const store = createTabStore(storage);

    store.getState().addTab("/tmp/a");
    store.getState().toggleWorkspaceExpanded("/tmp/a");

    expect(storage.getItem(WORKSPACE_EXPANSION_STORAGE_KEY)).toBe(
      JSON.stringify({ "/tmp/a": false }),
    );
  });

  it("restores workspace expanded state from local storage", () => {
    const storage = createMemoryStorage({
      [WORKSPACE_EXPANSION_STORAGE_KEY]: JSON.stringify({
        "/tmp/a": false,
        "/tmp/b": true,
      }),
    });
    const store = createTabStore(storage);

    store.getState().restoreTabs(["/tmp/a", "/tmp/b"], 1);

    expect(store.getState().expandedWorkspacePaths.has("/tmp/a")).toBe(false);
    expect(store.getState().expandedWorkspacePaths.has("/tmp/b")).toBe(true);
  });

  it("reorders only workspace tabs when sorting from the sidebar", () => {
    const store = createTabStore();

    store.getState().addTab("/tmp/a");
    store.getState().addTab("/tmp/b");
    store.getState().openSettingsTab();
    store.getState().reorderTabs(2, 1);

    expect(store.getState().tabs.map((tab) => tab.label)).toEqual(["b", "settings", "a"]);

    store.getState().reorderWorkspaceTabs(1, 0);

    expect(store.getState().tabs.map((tab) => tab.label)).toEqual(["a", "settings", "b"]);
    expect(store.getState().tabs.filter(isWorkspaceTab).map((tab) => tab.workspacePath)).toEqual([
      "/tmp/a",
      "/tmp/b",
    ]);
  });

  it("reopens a collapsed workspace without toggling it shut again", () => {
    const activateTab = vi.fn();
    const toggleWorkspaceExpanded = vi.fn();

    applyWorkspaceTriggerSelection({
      tabId: "tab-a",
      workspacePath: "/tmp/a",
      isExpanded: false,
      activateTab,
      toggleWorkspaceExpanded,
    });

    expect(activateTab).toHaveBeenCalledWith("tab-a");
    expect(toggleWorkspaceExpanded).not.toHaveBeenCalled();
  });

  it("collapses an expanded workspace after activating it", () => {
    const activateTab = vi.fn();
    const toggleWorkspaceExpanded = vi.fn();

    applyWorkspaceTriggerSelection({
      tabId: "tab-a",
      workspacePath: "/tmp/a",
      isExpanded: true,
      activateTab,
      toggleWorkspaceExpanded,
    });

    expect(activateTab).toHaveBeenCalledWith("tab-a");
    expect(toggleWorkspaceExpanded).toHaveBeenCalledWith("/tmp/a");
  });
});
