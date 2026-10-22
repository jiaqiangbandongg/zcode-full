import { describe, expect, it } from "vitest";
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
  it("reuses unchanged tabs when opening a draft but publishes actual reconnection metadata", () => {
    const store = createTabStore();
    const identity = "remote:server:source-a:/srv/app";
    store.getState().addTab("/srv/app", {
      workspaceIdentity: identity,
      workspacePurpose: "project",
      remoteSessionId: "connection-1",
    });
    const original = store.getState().tabs;
    store.getState().addTab("/srv/app", {
      workspaceIdentity: identity,
      workspacePurpose: "project",
    });
    expect(store.getState().tabs).toBe(original);
    store.getState().addTab("/srv/app", {
      workspaceIdentity: identity,
      remoteSessionId: "connection-2",
    });
    expect(store.getState().tabs).not.toBe(original);
    expect(store.getState().tabs).toHaveLength(1);
    expect(store.getState().tabs[0]).toMatchObject({
      workspaceIdentity: identity,
      workspacePurpose: "project",
      remoteSessionId: "connection-2",
    });
  });
  it("RPN-02 keeps expansion and order isolated for same-path remote projects", () => {
    const storage = createMemoryStorage();
    const store = createTabStore(storage);
    const a = "remote:server:source-a:/srv/app";
    const b = "remote:server:source-b:/srv/app";
    store.getState().addTab("/srv/app", { workspaceIdentity: a });
    store.getState().addTab("/srv/app", { workspaceIdentity: b });
    store.getState().toggleWorkspaceExpanded(a);
    expect(store.getState().expandedWorkspacePaths.has(a)).toBe(false);
    expect(store.getState().expandedWorkspacePaths.has(b)).toBe(true);
    store.getState().reorderWorkspaceTabs(0, 1);
    expect(
      store
        .getState()
        .tabs.filter(isWorkspaceTab)
        .map((tab) => tab.workspaceIdentity),
    ).toEqual([a, b]);
    const restored = createTabStore(storage);
    restored.getState().restoreTabs(
      [
        { workspacePath: "/srv/app", workspaceIdentity: a },
        { workspacePath: "/srv/app", workspaceIdentity: b },
      ],
      0,
    );
    expect(restored.getState().expandedWorkspacePaths.has(a)).toBe(false);
    expect(restored.getState().expandedWorkspacePaths.has(b)).toBe(true);
  });
  it("opens only one settings tab per window", () => {
    const store = createTabStore();

    store.getState().openSettingsTab();
    store.getState().openSettingsTab();

    const settingsTabs = store.getState().tabs.filter((tab) => tab.id === SETTINGS_TAB_ID);
    expect(settingsTabs).toHaveLength(1);
    expect(store.getState().activeTabId).toBe(SETTINGS_TAB_ID);
  });

  it("closeTab 只为带远端身份的 tab 发布 lastClosedWorkspaceEvent", () => {
    // 契约：本地 tab 关闭不进入远程关闭链路，其持久化移除只依赖“按当前 tabs 序列化”；
    // 带 stable identity 的远程 tab 关闭则必须发布 user-close 事件供远程流程清理。
    const store = createTabStore();
    const stableIdentity = "remote:server:11111111-1111-4111-8111-111111111111:/workspace/demo";

    const localTabId = store.getState().addTab("/tmp/local");
    store.getState().closeTab(localTabId);
    expect(store.getState().lastClosedWorkspaceEvent).toBeNull();

    const remoteTabId = store.getState().addTab("/workspace/demo", {
      workspaceIdentity: stableIdentity,
      remoteTarget: { kind: "ssh", host: "dev.example.com", port: 22, username: "alice" },
    });
    store.getState().closeTab(remoteTabId);
    expect(store.getState().lastClosedWorkspaceEvent).toEqual({
      sequence: 1,
      workspaceKey: stableIdentity,
      origin: "user-close",
    });
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

    const reusedTab = store
      .getState()
      .tabs.find((tab) => isWorkspaceTab(tab) && tab.workspacePath === "/workspace/demo");

    expect(reusedTab && isWorkspaceTab(reusedTab) ? reusedTab.remoteSessionId : null).toBe(
      "remote-session-1",
    );
    expect(reusedTab && isWorkspaceTab(reusedTab) ? reusedTab.workspaceIdentity : null).toBe(
      "remote:docker:demo:/workspace/demo",
    );
  });

  it("rekeys a restored legacy remote tab when Host returns the stable Source Server identity", () => {
    const store = createTabStore();
    const legacyIdentity = "remote:ssh:dev.example.com:22:alice:/workspace/demo";
    const stableIdentity = "remote:server:server-1:/workspace/demo";
    const firstId = store.getState().addTab("/workspace/demo", {
      workspaceIdentity: legacyIdentity,
    });

    const rekeyedId = store.getState().ensureWorkspaceTab("/workspace/demo", {
      previousWorkspaceIdentity: legacyIdentity,
      workspaceIdentity: stableIdentity,
      remoteSessionId: "remote-session-1",
    });

    expect(rekeyedId).toBe(firstId);
    expect(store.getState().tabs.filter(isWorkspaceTab)).toEqual([
      expect.objectContaining({
        id: firstId,
        workspaceIdentity: stableIdentity,
        remoteSessionId: "remote-session-1",
      }),
    ]);
    expect(store.getState().activeTabId).toBe(firstId);
    expect(store.getState().activeWorkspaceIdentity).toBe(stableIdentity);
  });

  it("rekeys the recently active remote identity without leaving settings", () => {
    const store = createTabStore();
    const legacyIdentity = "remote:ssh:dev.example.com:22:alice:/workspace/demo";
    const stableIdentity = "remote:server:server-1:/workspace/demo";
    store.getState().addTab("/workspace/demo", {
      workspaceIdentity: legacyIdentity,
    });
    store.getState().openSettingsTab();

    store.getState().ensureWorkspaceTab("/workspace/demo", {
      previousWorkspaceIdentity: legacyIdentity,
      workspaceIdentity: stableIdentity,
    });

    expect(store.getState().activeTabId).toBe(SETTINGS_TAB_ID);
    expect(store.getState().activeWorkspacePath).toBe("/workspace/demo");
    expect(store.getState().activeWorkspaceIdentity).toBe(stableIdentity);
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

    expect(
      store
        .getState()
        .tabs.filter(isWorkspaceTab)
        .map((tab) => tab.workspacePath),
    ).toEqual(["/tmp/c", "/tmp/b", "/tmp/a"]);
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
    expect(
      store
        .getState()
        .tabs.filter(isWorkspaceTab)
        .map((tab) => tab.workspacePath),
    ).toEqual(["/tmp/imported", "/tmp/current"]);
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
    expect(
      store
        .getState()
        .tabs.filter(isWorkspaceTab)
        .map((tab) => tab.workspacePath),
    ).toEqual(["/tmp/a", "/tmp/b"]);
  });
});

describe("文件面板跨工作区请求", () => {
  it.each([undefined, "remote:target"])(
    "目标身份 %s 与激活 workspace 一致，旧消费不能清除新请求",
    (identity) => {
      const store = createTabStore();
      const original = store.getState().addTab("/original");
      const target = {
        workspacePath: "/target",
        workspaceIdentity: identity,
        workspaceRemoteSessionId: identity ? "remote-session" : undefined,
      };
      store.getState().requestFileManager(target);
      expect(store.getState().activeWorkspacePath).toBe("/target");
      expect(store.getState().activeWorkspaceIdentity).toBe(identity ?? null);
      expect(store.getState().pendingFileManagerTarget).toBe(target);
      const next = { ...target, revealPath: "/target/file.ts" };
      store.getState().requestFileManager(next);
      store.getState().consumeFileManager(target);
      expect(store.getState().pendingFileManagerTarget).toBe(next);
      store.getState().consumeFileManager(next);
      expect(store.getState().pendingFileManagerTarget).toBeNull();
      store.getState().activateTab(original);
      expect(store.getState().activeWorkspacePath).toBe("/original");
    },
  );
});
