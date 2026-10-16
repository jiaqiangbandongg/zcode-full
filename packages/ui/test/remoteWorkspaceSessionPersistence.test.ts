import { describe, expect, it, vi } from "vitest";
import {
  buildRemoteWorkspacePersistPatch,
  restorePersistedRemoteWorkspaceSessions,
} from "@/root/remoteWorkspaceSessionPersistence.js";
import {
  buildRemoteWorkspaceIdentity,
  getRemoteWorkspaceSessionEntries,
  removeRemoteWorkspaceSessionEntries,
} from "@/lib/remoteWorkspaceHistory.js";
import { createTabStore, isWorkspaceTab } from "@/store/tabStore.js";

describe("restorePersistedRemoteWorkspaceSessions", () => {
  it("active-first 模式先恢复 active workspace，首帧后再补齐完整顺序", () => {
    const tabStoreApi = createTabStore();

    const result = restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [
          { kind: "local", workspacePath: "/workspace/a" },
          { kind: "local", workspacePath: "/workspace/active" },
          { kind: "local", workspacePath: "/workspace/b" },
        ],
        lastActiveTabIndex: 1,
      },
      restoreMode: "active-first",
      tabStoreApi,
    });

    expect(
      tabStoreApi
        .getState()
        .tabs.filter(isWorkspaceTab)
        .map((tab) => tab.workspacePath),
    ).toEqual(["/workspace/active"]);

    result?.deferredRestore?.();

    expect(
      tabStoreApi
        .getState()
        .tabs.filter(isWorkspaceTab)
        .map((tab) => tab.workspacePath),
    ).toEqual(["/workspace/a", "/workspace/active", "/workspace/b"]);
  });

  it("active-first 补齐不会复活用户在 idle callback 前关闭的 active workspace", () => {
    const tabStoreApi = createTabStore();
    const result = restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [
          { kind: "local", workspacePath: "/workspace/a" },
          { kind: "local", workspacePath: "/workspace/active" },
          { kind: "local", workspacePath: "/workspace/b" },
        ],
        lastActiveTabIndex: 1,
      },
      restoreMode: "active-first",
      tabStoreApi,
    });
    const activeTabId = tabStoreApi.getState().activeTabId;
    expect(activeTabId).not.toBeNull();

    tabStoreApi.getState().closeTab(activeTabId!);
    result?.deferredRestore?.();

    expect(
      tabStoreApi
        .getState()
        .tabs.filter(isWorkspaceTab)
        .map((tab) => tab.workspacePath),
    ).toEqual(["/workspace/a", "/workspace/b"]);
  });

  it("恢复本地会话工作区时保留用途", () => {
    const restoreTabs = vi.fn();

    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [
          {
            kind: "local",
            workspacePath: "/Users/demo/.zcode/workspace/default",
            workspacePurpose: "conversation",
          },
        ],
        lastActiveTabIndex: 0,
      },
      tabStoreApi: {
        getState: () => ({ restoreTabs }),
      } as never,
    });

    expect(restoreTabs).toHaveBeenCalledWith(
      [
        {
          workspacePath: "/Users/demo/.zcode/workspace/default",
          workspacePurpose: "conversation",
        },
      ],
      0,
    );
  });

  it("canonical conversation workspace 的旧 project 用途会在恢复时自愈", () => {
    const restoreTabs = vi.fn();
    const conversationWorkspacePath = "/Users/demo/.zcode/workspace/default";

    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [
          { kind: "local", workspacePath: "/Users/demo/project" },
          {
            kind: "local",
            workspacePath: conversationWorkspacePath,
            workspacePurpose: "project",
          },
        ],
        lastActiveTabIndex: 0,
      },
      conversationWorkspacePath,
      tabStoreApi: {
        getState: () => ({ restoreTabs }),
      } as never,
    });

    expect(restoreTabs).toHaveBeenCalledWith(
      [
        "/Users/demo/project",
        {
          workspacePath: conversationWorkspacePath,
          workspacePurpose: "conversation",
        },
      ],
      0,
    );
  });

  it("canonical conversation workspace 会替换持久化遗留的其他 conversation 路径", () => {
    const restoreTabs = vi.fn();
    const conversationWorkspacePath = "/Users/demo/.zcode/workspace/default";

    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [
          { kind: "local", workspacePath: "/Users/demo/project" },
          {
            kind: "local",
            workspacePath: conversationWorkspacePath,
            workspacePurpose: "conversation",
          },
          {
            kind: "local",
            workspacePath: "/private/tmp/test/.zcode/workspace/default",
            workspacePurpose: "conversation",
          },
        ],
        lastActiveTabIndex: 2,
      },
      conversationWorkspacePath,
      tabStoreApi: {
        getState: () => ({ restoreTabs }),
      } as never,
    });

    expect(restoreTabs).toHaveBeenCalledWith(
      [
        "/Users/demo/project",
        {
          workspacePath: conversationWorkspacePath,
          workspacePurpose: "conversation",
        },
      ],
      1,
    );
  });

  it("持久化列表缺少 conversation workspace 时非激活补建", () => {
    const restoreTabs = vi.fn();
    const conversationWorkspacePath = "/Users/demo/.zcode/workspace/default";

    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [
          { kind: "local", workspacePath: "/Users/demo/project" },
        ],
        lastActiveTabIndex: 0,
      },
      conversationWorkspacePath,
      tabStoreApi: {
        getState: () => ({ restoreTabs }),
      } as never,
    });

    expect(restoreTabs).toHaveBeenCalledWith(
      [
        "/Users/demo/project",
        {
          workspacePath: conversationWorkspacePath,
          workspacePurpose: "conversation",
        },
      ],
      0,
    );
  });

  it("仅将启动期命中的本地 workspace 恢复为临时不可用状态", () => {
    const restoreTabs = vi.fn();

    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [
          { kind: "local", workspacePath: "/workspace/available" },
          { kind: "local", workspacePath: "/workspace/missing" },
        ],
        lastActiveTabIndex: 1,
      },
      unavailableWorkspacePath: "/workspace/missing",
      tabStoreApi: {
        getState: () => ({ restoreTabs }),
      } as never,
    });

    expect(restoreTabs).toHaveBeenCalledWith(
      [
        "/workspace/available",
        {
          workspacePath: "/workspace/missing",
          availability: "unavailable-local-directory",
        },
      ],
      1,
    );
  });

  it("远程 workspace 即使路径同名也不应用本地不可用状态", () => {
    const restoreTabs = vi.fn();

    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [
          {
            kind: "remote",
            workspacePath: "/workspace/missing",
            target: { kind: "docker", container: "demo" },
            lastOpenedAt: 1,
            lastConnectionStatus: "failed",
          },
        ],
        lastActiveTabIndex: 0,
      },
      unavailableWorkspacePath: "/workspace/missing",
      tabStoreApi: {
        getState: () => ({ restoreTabs }),
      } as never,
    });

    expect(restoreTabs.mock.calls[0]?.[0]?.[0]).not.toHaveProperty("availability");
  });

  it("启动时恢复远程断开态 tab，但不再自动重连", () => {
    const restoreTabs = vi.fn();

    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [
          {
            kind: "remote",
            workspacePath: "/workspace/demo",
            target: {
              kind: "docker",
              container: "demo",
            },
            lastOpenedAt: 1,
            lastConnectionStatus: "failed",
          },
        ],
        lastActiveTabIndex: 0,
      },
      tabStoreApi: {
        getState: () => ({
          restoreTabs,
        }),
      } as never,
    });

    const expectedWorkspaceIdentity = buildRemoteWorkspaceIdentity("/workspace/demo", {
      kind: "docker",
      container: "demo",
    });

    expect(restoreTabs).toHaveBeenCalledWith(
      [
        {
          workspacePath: "/workspace/demo",
          remoteTarget: {
            kind: "docker",
            container: "demo",
          },
          workspaceIdentity: expectedWorkspaceIdentity,
        },
      ],
      0,
    );
  });

  it("启动时 lastActiveTabIndex 指向远程 workspace 时跳到后面的本地 workspace", () => {
    const restoreTabs = vi.fn();

    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [
          {
            kind: "remote",
            workspacePath: "/root",
            workspaceIdentity: "remote:ssh:localhost:2222:root:/root",
            target: {
              kind: "ssh",
              host: "localhost",
              port: 2222,
              username: "root",
            },
            lastOpenedAt: 1,
            lastConnectionStatus: "connected",
          },
          {
            kind: "local",
            workspacePath: "/workspace/local",
          },
        ],
        lastActiveTabIndex: 0,
      },
      tabStoreApi: {
        getState: () => ({
          restoreTabs,
        }),
      } as never,
    });

    expect(restoreTabs).toHaveBeenCalledWith(
      [
        {
          workspacePath: "/root",
          remoteTarget: {
            kind: "ssh",
            host: "localhost",
            port: 2222,
            username: "root",
          },
          workspaceIdentity: "remote:ssh:localhost:2222:root:/root",
        },
        "/workspace/local",
      ],
      1,
    );
  });

  it("启动时 lastActiveTabIndex 指向末尾远程 workspace 时回到已有本地 workspace", () => {
    const restoreTabs = vi.fn();

    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [
          {
            kind: "remote",
            workspacePath: "/root-a",
            workspaceIdentity: "remote:ssh:localhost:2222:root:/root-a",
            target: {
              kind: "ssh",
              host: "localhost",
              port: 2222,
              username: "root",
            },
            lastOpenedAt: 1,
            lastConnectionStatus: "connected",
          },
          {
            kind: "local",
            workspacePath: "/workspace/local",
          },
          {
            kind: "remote",
            workspacePath: "/root-b",
            workspaceIdentity: "remote:ssh:localhost:2222:root:/root-b",
            target: {
              kind: "ssh",
              host: "localhost",
              port: 2222,
              username: "root",
            },
            lastOpenedAt: 2,
            lastConnectionStatus: "connected",
          },
        ],
        lastActiveTabIndex: 2,
      },
      tabStoreApi: {
        getState: () => ({
          restoreTabs,
        }),
      } as never,
    });

    expect(restoreTabs).toHaveBeenCalledWith(
      [
        {
          workspacePath: "/root-a",
          remoteTarget: {
            kind: "ssh",
            host: "localhost",
            port: 2222,
            username: "root",
          },
          workspaceIdentity: "remote:ssh:localhost:2222:root:/root-a",
        },
        "/workspace/local",
        {
          workspacePath: "/root-b",
          remoteTarget: {
            kind: "ssh",
            host: "localhost",
            port: 2222,
            username: "root",
          },
          workspaceIdentity: "remote:ssh:localhost:2222:root:/root-b",
        },
      ],
      1,
    );
  });

  it("同一远程身份只恢复一次", () => {
    const restoreTabs = vi.fn();
    const sharedWorkspaceIdentity = buildRemoteWorkspaceIdentity("/workspace/demo", {
      kind: "docker",
      container: "demo",
    });

    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [
          {
            kind: "remote",
            workspacePath: "/workspace/demo",
            workspaceIdentity: sharedWorkspaceIdentity,
            target: {
              kind: "docker",
              container: "demo",
            },
            lastOpenedAt: 1,
            lastConnectionStatus: "failed",
          },
          {
            kind: "remote",
            workspacePath: "/workspace/alias",
            workspaceIdentity: sharedWorkspaceIdentity,
            target: {
              kind: "docker",
              container: "demo",
            },
            lastOpenedAt: 1,
            lastConnectionStatus: "failed",
          },
        ],
        lastActiveTabIndex: 0,
      },
      tabStoreApi: {
        getState: () => ({
          restoreTabs,
        }),
      } as never,
    });

    expect(restoreTabs).toHaveBeenCalledWith(
      [
        {
          workspacePath: "/workspace/demo",
          remoteTarget: {
            kind: "docker",
            container: "demo",
          },
          workspaceIdentity: sharedWorkspaceIdentity,
        },
      ],
      0,
    );
  });

  it("远程入口不可见时只恢复本地 workspace", () => {
    const restoreTabs = vi.fn();

    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [
          { kind: "local", workspacePath: "/workspace/local" },
          {
            kind: "remote",
            workspacePath: "/workspace/demo",
            target: {
              kind: "docker",
              container: "demo",
            },
            lastOpenedAt: 1,
            lastConnectionStatus: "failed",
          },
        ],
        lastActiveTabIndex: 1,
      },
      tabStoreApi: {
        getState: () => ({
          restoreTabs,
        }),
      } as never,
      allowRemoteWorkspaceRestore: false,
    });

    expect(restoreTabs).toHaveBeenCalledWith(["/workspace/local"], 0);
  });

  it("远程入口隐藏后，后续持久化仍保留远程会话快照", () => {
    const restoreTabs = vi.fn();
    const settings = {
      lastWorkspaceSession: [
        { kind: "local" as const, workspacePath: "/workspace/local" },
        {
          kind: "remote" as const,
          workspacePath: "/workspace/demo",
          target: {
            kind: "docker" as const,
            container: "demo",
          },
          lastOpenedAt: 1,
          lastConnectionStatus: "failed" as const,
        },
      ],
      lastActiveTabIndex: 1,
    };

    restorePersistedRemoteWorkspaceSessions({
      settings,
      tabStoreApi: {
        getState: () => ({
          restoreTabs,
        }),
      } as never,
      allowRemoteWorkspaceRestore: false,
    });

    expect(restoreTabs).toHaveBeenCalledWith(["/workspace/local"], 0);

    const remoteSessions = getRemoteWorkspaceSessionEntries(settings);
    const patch = buildRemoteWorkspacePersistPatch(
      {
        tabs: [
          {
            id: "local-1",
            kind: "workspace",
            workspacePath: "/workspace/local",
            label: "local",
          },
        ],
        activeWorkspacePath: "/workspace/local",
      } as never,
      remoteSessions,
    );

    expect(patch.lastWorkspaceSession).toEqual([
      { kind: "local", workspacePath: "/workspace/local" },
      settings.lastWorkspaceSession[1],
    ]);
  });

  it("持久化本地会话工作区时保留用途", () => {
    const patch = buildRemoteWorkspacePersistPatch(
      {
        tabs: [
          {
            id: "conversation-1",
            kind: "workspace",
            workspacePath: "/Users/demo/.zcode/workspace/default",
            workspacePurpose: "conversation",
            availability: "unavailable-local-directory",
            label: "default",
          },
        ],
        activeWorkspacePath: "/Users/demo/.zcode/workspace/default",
      } as never,
      [],
    );

    expect(patch.lastWorkspaceSession).toEqual([
      {
        kind: "local",
        workspacePath: "/Users/demo/.zcode/workspace/default",
        workspacePurpose: "conversation",
      },
    ]);
  });

  it("用户移除远程 tab 后，持久化补丁不再保留对应远程快照", () => {
    const remoteSession = {
      kind: "remote" as const,
      workspacePath: "/workspace/demo",
      workspaceIdentity: "remote:docker:demo:/workspace/demo",
      target: {
        kind: "docker" as const,
        container: "demo",
      },
      lastOpenedAt: 1,
      lastConnectionStatus: "failed" as const,
    };
    const removal = removeRemoteWorkspaceSessionEntries(
      [remoteSession],
      ["remote:docker:demo:/workspace/demo"],
    );

    const patch = buildRemoteWorkspacePersistPatch(
      {
        tabs: [],
        activeWorkspacePath: null,
      } as never,
      removal.nextRemoteSessions,
    );

    expect(patch.lastWorkspaceSession).toEqual([]);
  });
});
