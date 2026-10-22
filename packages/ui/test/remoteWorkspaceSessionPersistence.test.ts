import { describe, expect, it, vi } from "vitest";
import {
  buildRemoteWorkspacePersistPatch,
  projectRemoteConversationWorkspacePurpose,
  restorePersistedRemoteWorkspaceSessions,
} from "@/root/remoteWorkspaceSessionPersistence.js";
import {
  buildRemoteWorkspaceIdentity,
  getRemoteWorkspaceSessionEntries,
  projectRemoteWorkspaceSessionIdentityAliases,
} from "@/lib/remoteWorkspaceHistory.js";
import { createTabStore, isWorkspaceTab } from "@/store/tabStore.js";

describe("restorePersistedRemoteWorkspaceSessions", () => {
  it.each(["A", "B"])(
    "新版远程活动目录 %s 恢复，旧投影中的 sibling 不创建 attachment 候选",
    (active) => {
      const makeEntry = (name: string) => ({
        kind: "remote" as const,
        workspacePath: `/srv/${name}`,
        workspaceIdentity: `remote:server:source-1:/srv/${name}`,
        target: { kind: "ssh" as const, host: "dev.example.com", username: "dev" },
        lastOpenedAt: 1,
        lastConnectionStatus: "connected" as const,
      });
      // 真实冷启动轨迹同时有旧 A/B 投影和新版单一活动目录，不能把旧投影当作 open set。
      const settings = {
        lastActiveWorkspace: makeEntry(active),
        lastWorkspaceSession: [makeEntry("A"), makeEntry("B")],
        lastActiveTabIndex: 0,
      };
      const tabStoreApi = createTabStore();
      const restored = restorePersistedRemoteWorkspaceSessions({
        settings,
        tabStoreApi,
        restoreMode: "active-first",
      });
      expect(restored?.deferredRestore).toBeUndefined();
      expect(getRemoteWorkspaceSessionEntries(settings).map((e) => e.workspacePath)).toEqual([
        `/srv/${active}`,
      ]);
      expect(
        tabStoreApi
          .getState()
          .tabs.filter(isWorkspaceTab)
          .map((t) => t.workspaceIdentity),
      ).toEqual([`remote:server:source-1:/srv/${active}`]);
      expect(tabStoreApi.getState().activeWorkspaceIdentity).toBe(
        `remote:server:source-1:/srv/${active}`,
      );
    },
  );

  it.each(["all", "active-first"] as const)(
    "新版活动项目失效时直接进入无项目工作区，补齐不抢占用户选择（%s）",
    (restoreMode) => {
      const tabStoreApi = createTabStore();
      const result = restorePersistedRemoteWorkspaceSessions({
        settings: {
          lastActiveWorkspace: { kind: "local", workspacePath: "/workspace/missing" },
        },
        unavailableWorkspacePath: "/workspace/missing",
        conversationWorkspacePath: "/workspace/default",
        restoreMode,
        tabStoreApi,
      });

      expect(tabStoreApi.getState().activeWorkspacePath).toBe("/workspace/default");
      expect(tabStoreApi.getState().tabs.filter(isWorkspaceTab)).toContainEqual(
        expect.objectContaining({
          workspacePath: "/workspace/default",
          workspacePurpose: "conversation",
        }),
      );
      tabStoreApi.getState().addTab("/workspace/user-selected");
      result?.deferredRestore?.();
      expect(tabStoreApi.getState().activeWorkspacePath).toBe("/workspace/user-selected");
      expect(tabStoreApi.getState().tabs.filter(isWorkspaceTab)).toContainEqual(
        expect.objectContaining({
          workspacePath: "/workspace/missing",
          availability: "unavailable-local-directory",
        }),
      );
    },
  );

  it.each(["before", "after", "absent"] as const)(
    "旧版首个项目失效时无项目目录的位置不影响默认草稿（%s）",
    (position) => {
      const tabStoreApi = createTabStore();
      const missing = { kind: "local" as const, workspacePath: "/workspace/missing" };
      const conversation = {
        kind: "local" as const,
        workspacePath: "/workspace/default",
        workspacePurpose: "conversation" as const,
      };
      restorePersistedRemoteWorkspaceSessions({
        settings: {
          lastWorkspaceSession:
            position === "before"
              ? [conversation, missing]
              : position === "after"
                ? [missing, conversation]
                : [missing],
          lastActiveTabIndex: position === "before" ? 1 : 0,
        },
        unavailableWorkspacePath: missing.workspacePath,
        conversationWorkspacePath: conversation.workspacePath,
        tabStoreApi,
      });

      expect(tabStoreApi.getState().activeWorkspacePath).toBe(conversation.workspacePath);
      expect(
        tabStoreApi
          .getState()
          .tabs.filter(isWorkspaceTab)
          .filter((tab) => tab.workspacePath === conversation.workspacePath),
      ).toHaveLength(1);
    },
  );

  it("失效的非活动项目不改变当前有效项目的选择", () => {
    const tabStoreApi = createTabStore();
    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [
          { kind: "local", workspacePath: "/workspace/missing" },
          { kind: "local", workspacePath: "/workspace/available" },
        ],
        lastActiveTabIndex: 1,
      },
      unavailableWorkspacePath: "/workspace/missing",
      conversationWorkspacePath: "/workspace/default",
      tabStoreApi,
    });
    expect(tabStoreApi.getState().activeWorkspacePath).toBe("/workspace/available");
  });

  it("新建任务的活动 cwd 保持独立，不被旧 canonical conversation 目录替换", () => {
    const tabStoreApi = createTabStore();
    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastActiveWorkspace: {
          kind: "local",
          workspacePath: "/workspace/new-task",
          workspacePurpose: "conversation",
        },
      },
      conversationWorkspacePath: "/workspace/default",
      tabStoreApi,
    });
    expect(
      tabStoreApi
        .getState()
        .tabs.filter(isWorkspaceTab)
        .map((tab) => tab.workspacePath),
    ).toEqual(["/workspace/new-task"]);
  });
  it("新版只恢复 lastActiveWorkspace，兼容字段中的旧项目不参与恢复", () => {
    const tabStoreApi = createTabStore();
    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastActiveWorkspace: { kind: "local", workspacePath: "/selected" },
        lastWorkspaceSession: [{ kind: "local", workspacePath: "/deleted" }],
        lastActiveTabIndex: 4,
      },
      tabStoreApi,
    });
    expect(
      tabStoreApi
        .getState()
        .tabs.filter(isWorkspaceTab)
        .map((tab) => tab.workspacePath),
    ).toEqual(["/selected"]);
  });

  it("新版 null 活动选择不会回读旧兼容集合", () => {
    const tabStoreApi = createTabStore();
    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastActiveWorkspace: null,
        lastWorkspaceSession: [{ kind: "local", workspacePath: "/deleted" }],
      },
      tabStoreApi,
    });
    expect(tabStoreApi.getState().tabs.filter(isWorkspaceTab)).toEqual([]);
  });

  it("窗口只写活动目录，并按 identity 区分同路径的远端", () => {
    const tabStoreApi = createTabStore();
    const target = { kind: "ssh" as const, host: "example.test", username: "user" };
    const sessions = ["a", "b"].map((id) => ({
      kind: "remote" as const,
      workspacePath: "/same",
      workspaceIdentity: `remote:server:${id}:/same`,
      target,
      lastOpenedAt: 1,
      lastConnectionStatus: "connected" as const,
    }));
    tabStoreApi.getState().restoreTabs(
      sessions.map((entry) => ({
        workspacePath: entry.workspacePath,
        workspaceIdentity: entry.workspaceIdentity,
        remoteTarget: target,
      })),
      1,
    );
    expect(buildRemoteWorkspacePersistPatch(tabStoreApi.getState(), sessions)).toEqual({
      lastActiveWorkspace: sessions[1],
    });
  });

  it("projects a legacy route session to the Source Server stable identity before restoring UI state", () => {
    const legacyIdentity = "remote:ssh:dev.example.com:22:alice:/srv/project";
    const stableIdentity = "remote:server:server-1:/srv/project";
    const settings = {
      lastWorkspaceSession: [
        {
          kind: "remote" as const,
          workspacePath: "/srv/project",
          workspaceIdentity: legacyIdentity,
          target: {
            kind: "ssh" as const,
            host: "dev.example.com",
            port: 22,
            username: "alice",
          },
          lastOpenedAt: 1,
          lastConnectionStatus: "failed" as const,
        },
      ],
      sourceServerWorkspaceHistory: [
        {
          workspacePath: "/srv/project",
          workspaceIdentity: stableIdentity,
          legacyWorkspaceIdentity: legacyIdentity,
          profileId: "profile-1",
          sourceServerId: "server-1",
          lastOpenedAt: 1,
        },
      ],
    };

    expect(getRemoteWorkspaceSessionEntries(settings)).toEqual([
      expect.objectContaining({ workspaceIdentity: stableIdentity }),
    ]);

    const tabStoreApi = createTabStore();
    restorePersistedRemoteWorkspaceSessions({ settings, tabStoreApi });
    expect(tabStoreApi.getState().tabs.filter(isWorkspaceTab)).toEqual([
      expect.objectContaining({ workspaceIdentity: stableIdentity }),
    ]);
  });

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

  it("RPN-09 excludes an old project entry identified by its exact canonical conversation record", () => {
    const restoreTabs = vi.fn();
    const sourceServerId = "11111111-1111-4111-8111-111111111111";
    const workspacePath = "/home/dev/.zcode/workspace/default";
    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [
          {
            kind: "remote",
            workspacePath,
            workspaceIdentity: `remote:server:${sourceServerId}:${workspacePath}`,
            target: { kind: "ssh", host: "linux-amd64-dev", username: "dev" },
            lastOpenedAt: 1,
            lastConnectionStatus: "connected",
          },
        ],
        remoteConversationWorkspaceBySourceServerId: {
          [sourceServerId]: { workspacePath, lastResolvedAt: 2 },
        },
      },
      tabStoreApi: { getState: () => ({ restoreTabs }) } as never,
    });

    expect(restoreTabs).not.toHaveBeenCalled();
  });

  it("持久化列表缺少 conversation workspace 时非激活补建", () => {
    const restoreTabs = vi.fn();
    const conversationWorkspacePath = "/Users/demo/.zcode/workspace/default";

    restorePersistedRemoteWorkspaceSessions({
      settings: {
        lastWorkspaceSession: [{ kind: "local", workspacePath: "/Users/demo/project" }],
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

  it("启动时恢复激活的远程 workspace，不跳到后面的本地项目", () => {
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
      0,
    );
  });

  it("启动时恢复末尾远程 workspace 的激活位置", () => {
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
      2,
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
});

describe("projectRemoteConversationWorkspacePurpose", () => {
  it("self-heals only the exact open entry recorded as the Source conversation path", () => {
    const sourceServerId = "11111111-1111-4111-8111-111111111111";
    const conversationPath = "/home/dev/.zcode/workspace/default";
    const conversation = {
      kind: "remote" as const,
      workspacePath: conversationPath,
      workspaceIdentity: `remote:server:${sourceServerId}:${conversationPath}`,
      workspacePurpose: "project" as const,
      target: { kind: "ssh" as const, host: "localhost", username: "dev" },
      lastOpenedAt: 1,
      lastConnectionStatus: "failed" as const,
    };
    const project = {
      ...conversation,
      workspacePath: "/home/dev",
      workspaceIdentity: `remote:server:${sourceServerId}:/home/dev`,
    };

    expect(
      projectRemoteConversationWorkspacePurpose([conversation, project], {
        [sourceServerId]: {
          workspacePath: conversationPath,
          lastResolvedAt: 2,
        },
      }),
    ).toEqual({
      remoteSessions: [{ ...conversation, workspacePurpose: "conversation" }, project],
      updatedEntries: [
        {
          workspacePath: conversationPath,
          workspaceIdentity: conversation.workspaceIdentity,
        },
      ],
    });
  });
});

describe("projectRemoteWorkspaceSessionIdentityAliases", () => {
  it("uses the Source conversation alias when project history has already been cleaned", () => {
    const sourceServerId = "11111111-1111-4111-8111-111111111111";
    const workspacePath = "/home/dev/.zcode/workspace/default";
    const target = {
      kind: "ssh" as const,
      host: "127.0.0.1",
      port: 2222,
      username: "dev",
    };
    const legacyIdentity = buildRemoteWorkspaceIdentity(workspacePath, target);
    const stableIdentity = `remote:server:${sourceServerId}:${workspacePath}`;

    const result = projectRemoteWorkspaceSessionIdentityAliases(
      [
        {
          kind: "remote",
          workspacePath,
          workspaceIdentity: legacyIdentity,
          target,
          workspacePurpose: "conversation",
          lastOpenedAt: 1,
          lastConnectionStatus: "connected",
        },
      ],
      {
        sourceServerWorkspaceHistory: [],
        connectionProfiles: [
          {
            profileId: "profile-127",
            sourceServerId,
            displayName: "127.0.0.1",
            transport: "ssh",
            target,
            createdAt: 1,
            lifecycleState: "active",
          },
        ],
        remoteConversationWorkspaceBySourceServerId: {
          [sourceServerId]: { workspacePath, lastResolvedAt: 2 },
        },
      },
    );

    expect(result.identityRekeys).toEqual([
      {
        workspacePath,
        previousWorkspaceIdentity: legacyIdentity,
        workspaceIdentity: stableIdentity,
      },
    ]);
    expect(result.remoteSessions[0]?.workspaceIdentity).toBe(stableIdentity);
  });

  it("uses every bound Profile route for a canonical project history entry", () => {
    const sourceServerId = "22222222-2222-4222-8222-222222222222";
    const workspacePath = "/home/dev";
    const target = {
      kind: "ssh" as const,
      host: "127.0.0.1",
      port: 2222,
      username: "dev",
    };
    const legacyIdentity = buildRemoteWorkspaceIdentity(workspacePath, target);
    const stableIdentity = `remote:server:${sourceServerId}:${workspacePath}`;

    const result = projectRemoteWorkspaceSessionIdentityAliases(
      [
        {
          kind: "remote",
          workspacePath,
          workspaceIdentity: legacyIdentity,
          target,
          lastOpenedAt: 1,
          lastConnectionStatus: "failed",
        },
      ],
      {
        sourceServerWorkspaceHistory: [
          {
            workspacePath,
            workspaceIdentity: stableIdentity,
            legacyWorkspaceIdentity: "remote:ssh:localhost:2222:dev:/home/dev",
            sourceServerId,
            profileId: "profile-localhost",
            lastOpenedAt: 2,
          },
        ],
        connectionProfiles: [
          {
            profileId: "profile-127",
            sourceServerId,
            displayName: "127.0.0.1",
            transport: "ssh",
            target,
            createdAt: 1,
            lifecycleState: "active",
          },
        ],
      },
    );

    expect(result.identityRekeys).toEqual([
      {
        workspacePath,
        previousWorkspaceIdentity: legacyIdentity,
        workspaceIdentity: stableIdentity,
      },
    ]);
    expect(result.remoteSessions[0]?.workspaceIdentity).toBe(stableIdentity);
  });
});
