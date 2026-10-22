// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { Emitter, Event, ProxyChannel } from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import type {
  AppSettings,
  IPlatformService,
  SourceServerManagementDirectoryDelta,
  SourceServerManagementSnapshot,
  SourceServerManagementStateDelta,
} from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import {
  collectStartupRemoteWorkspaceReconnectGroups,
  useRemoteWorkspaceHistory,
} from "@/root/useRemoteWorkspaceHistory.js";
import { createTabStore, isWorkspaceTab } from "@/store/tabStore.js";

const PROFILE_ID = "69d675cc-7753-4fa2-a1a1-594281f2c833";
const SOURCE_SERVER_ID = "82d727a5-8e58-4b82-b374-8081e7855666";
const DEFAULT_PATH = "/home/dev/.zcode/workspace/default";
const DEV_PATH = "/home/dev";
const defaultLegacyIdentity = `remote:ssh:localhost:2222:dev:${DEFAULT_PATH}`;
const devLegacyIdentity = `remote:ssh:localhost:2222:dev:${DEV_PATH}`;
const defaultStableIdentity = `remote:server:${SOURCE_SERVER_ID}:${DEFAULT_PATH}`;
const devStableIdentity = `remote:server:${SOURCE_SERVER_ID}:${DEV_PATH}`;

function remoteTarget() {
  return {
    kind: "ssh" as const,
    host: "localhost",
    port: 2222,
    username: "dev",
    sshConfigAlias: "linux-amd64-dev",
  };
}

function initialSettings(): AppSettings {
  return {
    lastWorkspaceSession: [
      {
        kind: "remote",
        workspacePath: DEFAULT_PATH,
        workspaceIdentity: defaultLegacyIdentity,
        target: remoteTarget(),
        lastOpenedAt: Date.now() - 2_000,
        lastConnectionStatus: "failed",
        lastConnectionError: "远程设备与当前版本不兼容",
      },
      {
        kind: "remote",
        workspacePath: DEV_PATH,
        workspaceIdentity: devLegacyIdentity,
        target: remoteTarget(),
        lastOpenedAt: Date.now() - 1_000,
        lastConnectionStatus: "connected",
      },
    ],
    sourceServerWorkspaceHistory: [
      {
        workspacePath: DEV_PATH,
        legacyWorkspaceIdentity: devLegacyIdentity,
        profileId: PROFILE_ID,
        lastOpenedAt: Date.now() - 1_000,
      },
    ],
    sourceServerDirectoryMigrationVersion: 1,
  };
}

function managementSnapshot(
  generation: number,
  identified: boolean,
): SourceServerManagementSnapshot {
  const settings = initialSettings();
  return {
    generation,
    profiles: [
      {
        profileId: PROFILE_ID,
        transport: "ssh",
        target: remoteTarget(),
        createdAt: 1,
        ...(identified ? { sourceServerId: SOURCE_SERVER_ID } : {}),
      },
    ],
    servers: identified
      ? [
          {
            sourceServerId: SOURCE_SERVER_ID,
            displayName: "linux-amd64-dev",
            declaredWorkspaces: [],
          },
        ]
      : [],
    workspaceHistory: settings.sourceServerWorkspaceHistory!.map((entry) =>
      identified
        ? {
            ...entry,
            sourceServerId: SOURCE_SERVER_ID,
            workspaceIdentity:
              entry.workspacePath === DEV_PATH ? devStableIdentity : defaultStableIdentity,
          }
        : entry,
    ),
    states: [
      {
        profileId: PROFILE_ID,
        ...(identified ? { sourceServerId: SOURCE_SERVER_ID } : {}),
        state: identified ? "updating" : "needs-upgrade",
        updatedAt: generation,
      },
    ],
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
  };
}

describe("useRemoteWorkspaceHistory Source Directory identity projection", () => {
  it("RPC 方法重新取值不使导航回调失稳，服务替换仍更新", () => {
    const credential = () =>
      ProxyChannel.toService<IServiceAccessor["credentialService"]>({
        call: vi.fn(async () => null) as never,
        listen: () => Event.None,
      });
    const services = { credentialService: credential(), settingService: {} } as IServiceAccessor;
    const tabStoreApi = createTabStore();
    const options = {
      intl: { formatMessage: ({ id }: { id: string }) => id } as never,
      platform: {
        onRemoteConnectionLog: () => () => {},
        onRemoteSessionClosed: () => () => {},
        onRemoteSessionReconnected: () => () => {},
      } as unknown as IPlatformService,
      supportsSettings: false,
      allowRemoteWorkspace: false,
      tabStoreApi,
      activateTabByPath: tabStoreApi.getState().activateTabByPath,
      addTab: tabStoreApi.getState().addTab,
    };
    const { result, rerender, unmount } = renderHook(
      ({ services }) => useRemoteWorkspaceHistory({ ...options, services }),
      { initialProps: { services } },
    );
    try {
      const before = result.current;
      rerender({ services });
      expect(result.current.remoteWorkspaceController).toBe(before.remoteWorkspaceController);
      expect(result.current.handleSelectRemoteProject).toBe(before.handleSelectRemoteProject);
      expect(result.current.handleReconnectRemoteWorkspace).toBe(
        before.handleReconnectRemoteWorkspace,
      );
      rerender({ services: { ...services, credentialService: credential() } });
      expect(result.current.remoteWorkspaceController).not.toBe(before.remoteWorkspaceController);
    } finally {
      unmount();
    }
  });
  it("rekeys restored legacy sessions and tabs before the online reconnect gate runs", async () => {
    const stateEmitter = new Emitter<SourceServerManagementStateDelta>();
    const directoryEmitter = new Emitter<SourceServerManagementDirectoryDelta>();
    let snapshot = managementSnapshot(1, false);
    const getSnapshot = vi.fn(async () => snapshot);
    const connectRemote = vi.fn();
    const services = {
      sourceServerManagementService: {
        getSnapshot,
        onDidChangeState: stateEmitter.event,
        onDidChangeDirectory: directoryEmitter.event,
      },
      settingService: {
        get: vi.fn(async () => initialSettings()),
        update: vi.fn(async () => undefined),
      },
      credentialService: {
        load: vi.fn(async () => null),
        save: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      fileService: {},
      modelSelectionService: {},
      providerSettingsService: {},
      zcodeSessionService: {},
    } as unknown as IServiceAccessor;
    const platform = {
      connectRemote,
      disposeRemoteSession: vi.fn(async () => undefined),
      onRemoteConnectionLog: vi.fn(() => () => undefined),
      onRemoteSessionClosed: vi.fn(() => () => undefined),
      onRemoteSessionReconnected: vi.fn(() => () => undefined),
    } as unknown as IPlatformService;
    const tabStoreApi = createTabStore();

    const { result, unmount } = renderHook(() =>
      useRemoteWorkspaceHistory({
        intl: { formatMessage: ({ id }: { id: string }) => id } as never,
        services,
        platform,
        supportsSettings: false,
        isDesktop: true,
        tabStoreApi,
        activateTabByPath: tabStoreApi.getState().activateTabByPath,
        addTab: tabStoreApi.getState().addTab,
      }),
    );

    await act(async () => {
      await result.current.restorePersistedSession(initialSettings());
    });
    await waitFor(() => expect(getSnapshot).toHaveBeenCalled());

    snapshot = managementSnapshot(2, true);
    act(() => directoryEmitter.fire({ generation: 2 }));

    await waitFor(() =>
      expect(
        result.current.remoteWorkspaceSessions.map((entry) => ({
          identity: entry.workspaceIdentity,
          status: entry.lastConnectionStatus,
        })),
      ).toEqual([
        { identity: defaultLegacyIdentity, status: "failed" },
        { identity: devStableIdentity, status: "connected" },
      ]),
    );
    const workspaceTabs = tabStoreApi.getState().tabs.filter(isWorkspaceTab);
    expect(workspaceTabs.map((tab) => tab.workspaceIdentity)).toEqual([
      defaultLegacyIdentity,
      devStableIdentity,
    ]);
    expect(tabStoreApi.getState().activeWorkspaceIdentity).toBe(defaultLegacyIdentity);
    expect(connectRemote).not.toHaveBeenCalled();

    expect(
      collectStartupRemoteWorkspaceReconnectGroups({
        sessions: result.current.remoteWorkspaceSessions,
        tabs: tabStoreApi.getState().tabs,
        attemptedWorkspaceKeys: new Set(),
        onlineSourceServerIds: new Set([SOURCE_SERVER_ID]),
        now: Date.now(),
      }),
    ).toEqual([
      {
        sourceServerId: SOURCE_SERVER_ID,
        entries: [
          expect.objectContaining({
            workspacePath: DEV_PATH,
            workspaceIdentity: devStableIdentity,
            lastConnectionStatus: "connected",
          }),
        ],
      },
    ]);

    unmount();
  });

  it("retains a rollback conversation identity as data without restoring its tab", async () => {
    const stateEmitter = new Emitter<SourceServerManagementStateDelta>();
    const directoryEmitter = new Emitter<SourceServerManagementDirectoryDelta>();
    const settings = {
      ...initialSettings(),
      connectionProfiles: [
        {
          profileId: PROFILE_ID,
          sourceServerId: SOURCE_SERVER_ID,
          transport: "ssh" as const,
          target: remoteTarget(),
          createdAt: 1,
        },
      ],
      remoteConversationWorkspaceBySourceServerId: {
        [SOURCE_SERVER_ID]: {
          workspacePath: DEFAULT_PATH,
          lastResolvedAt: Date.now(),
        },
      },
    } satisfies AppSettings;
    const services = {
      sourceServerManagementService: {
        getSnapshot: vi.fn(async () => managementSnapshot(1, true)),
        onDidChangeState: stateEmitter.event,
        onDidChangeDirectory: directoryEmitter.event,
        ensureConversationWorkspace: vi.fn(async () => ({
          path: DEFAULT_PATH,
          created: false,
          workspacePurpose: "conversation" as const,
        })),
      },
      settingService: {
        get: vi.fn(async () => settings),
        update: vi.fn(async () => undefined),
      },
      credentialService: {
        load: vi.fn(async () => null),
        save: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      fileService: {},
      modelSelectionService: {},
      providerSettingsService: {},
      zcodeSessionService: {},
    } as unknown as IServiceAccessor;
    const platform = {
      connectRemote: vi.fn(() => new Promise<string>(() => undefined)),
      disposeRemoteSession: vi.fn(async () => undefined),
      onRemoteConnectionLog: vi.fn(() => () => undefined),
      onRemoteSessionClosed: vi.fn(() => () => undefined),
      onRemoteSessionReconnected: vi.fn(() => () => undefined),
    } as unknown as IPlatformService;
    const tabStoreApi = createTabStore();

    const { result, unmount } = renderHook(() =>
      useRemoteWorkspaceHistory({
        intl: { formatMessage: ({ id }: { id: string }) => id } as never,
        services,
        platform,
        supportsSettings: false,
        isDesktop: true,
        tabStoreApi,
        activateTabByPath: tabStoreApi.getState().activateTabByPath,
        addTab: tabStoreApi.getState().addTab,
      }),
    );

    await act(async () => {
      await result.current.restorePersistedSession(settings);
    });

    await waitFor(() => {
      const tab = tabStoreApi
        .getState()
        .tabs.filter(isWorkspaceTab)
        .find((candidate) => candidate.workspacePath === DEFAULT_PATH);
      expect(tab).toBeUndefined();
    });
    expect(
      result.current.remoteWorkspaceSessions.find((entry) => entry.workspacePath === DEFAULT_PATH),
    ).toMatchObject({
      workspaceIdentity: defaultStableIdentity,
      workspacePurpose: "conversation",
    });

    expect(platform.connectRemote).not.toHaveBeenCalled();
    unmount();
  });

  it("restores all failed open workspaces at startup and after terminal disconnect without stale online retries", async () => {
    const stateEmitter = new Emitter<SourceServerManagementStateDelta>();
    const directoryEmitter = new Emitter<SourceServerManagementDirectoryDelta>();
    const settings = {
      ...initialSettings(),
      lastWorkspaceSession: [
        {
          kind: "remote" as const,
          workspacePath: DEFAULT_PATH,
          workspaceIdentity: defaultStableIdentity,
          target: remoteTarget(),
          lastOpenedAt: Date.now() - 2_000,
          lastConnectionStatus: "failed" as const,
          lastConnectionError: "远程连接已断开",
        },
        {
          kind: "remote" as const,
          workspacePath: DEV_PATH,
          workspaceIdentity: devStableIdentity,
          target: remoteTarget(),
          lastOpenedAt: Date.now() - 1_000,
          lastConnectionStatus: "failed" as const,
          lastConnectionError: "远程连接已断开",
        },
      ],
    } satisfies AppSettings;
    let snapshot: SourceServerManagementSnapshot = {
      ...managementSnapshot(1, true),
      states: [
        {
          profileId: PROFILE_ID,
          sourceServerId: SOURCE_SERVER_ID,
          state: "online",
          updatedAt: 1,
        },
      ],
    };
    let onSessionClosed: Parameters<IPlatformService["onRemoteSessionClosed"]>[0] | undefined;
    const connectRemote = vi.fn(async () => ({
      success: false as const,
      error: "stop after observing reconnect admission",
    }));
    const getSnapshot = vi.fn(async () => snapshot);
    const services = {
      sourceServerManagementService: {
        getSnapshot,
        onDidChangeState: stateEmitter.event,
        onDidChangeDirectory: directoryEmitter.event,
        ensureConversationWorkspace: vi.fn(async () => ({
          path: DEFAULT_PATH,
          created: false,
          workspacePurpose: "conversation" as const,
        })),
      },
      settingService: {
        get: vi.fn(async () => settings),
        update: vi.fn(async () => undefined),
      },
      credentialService: {
        load: vi.fn(async () => null),
        save: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      fileService: {},
      modelSelectionService: {},
      providerSettingsService: {},
      zcodeSessionService: {},
    } as unknown as IServiceAccessor;
    const platform = {
      connectRemote,
      disposeRemoteSession: vi.fn(async () => undefined),
      onRemoteConnectionLog: vi.fn(() => () => undefined),
      onRemoteSessionClosed: vi.fn((listener) => {
        onSessionClosed = listener;
        return () => undefined;
      }),
      onRemoteSessionReconnected: vi.fn(() => () => undefined),
    } as unknown as IPlatformService;
    const tabStoreApi = createTabStore();

    const { result, unmount } = renderHook(() =>
      useRemoteWorkspaceHistory({
        intl: { formatMessage: ({ id }: { id: string }) => id } as never,
        services,
        platform,
        supportsSettings: false,
        isDesktop: true,
        tabStoreApi,
        activateTabByPath: tabStoreApi.getState().activateTabByPath,
        addTab: tabStoreApi.getState().addTab,
      }),
    );

    await act(async () => {
      await result.current.restorePersistedSession(settings);
    });
    await waitFor(() => expect(connectRemote).toHaveBeenCalledTimes(2));
    expect(
      connectRemote.mock.calls.map(([, , context]) => context?.workspacePath).toSorted(),
    ).toEqual([DEFAULT_PATH, DEV_PATH].toSorted());
    await act(async () => {
      stateEmitter.fire({ generation: 1, state: snapshot.states[0]! });
      directoryEmitter.fire({ generation: 1 });
    });
    expect(connectRemote).toHaveBeenCalledTimes(2);
    connectRemote.mockClear();
    await waitFor(() => expect(onSessionClosed).toBeDefined());
    act(() => {
      tabStoreApi.getState().ensureWorkspaceTab(DEFAULT_PATH, {
        workspaceIdentity: defaultStableIdentity,
        remoteSessionId: "terminal-session",
      });
    });
    await act(async () => {
      onSessionClosed?.({
        sessionId: "terminal-session",
        reason: "host-exit",
        exitCode: null,
        signal: null,
        recoverable: false,
      });
    });
    await waitFor(() => expect(getSnapshot.mock.calls.length).toBeGreaterThan(1));
    expect(connectRemote).not.toHaveBeenCalled();

    snapshot = {
      ...snapshot,
      generation: 2,
      states: [
        {
          profileId: PROFILE_ID,
          sourceServerId: SOURCE_SERVER_ID,
          state: "offline",
          updatedAt: 2,
        },
      ],
    };
    act(() => {
      stateEmitter.fire({ generation: 2, state: snapshot.states[0]! });
    });

    snapshot = {
      ...snapshot,
      generation: 3,
      states: [
        {
          profileId: PROFILE_ID,
          sourceServerId: SOURCE_SERVER_ID,
          state: "online",
          updatedAt: 3,
        },
      ],
    };
    act(() => {
      stateEmitter.fire({ generation: 3, state: snapshot.states[0]! });
    });

    await waitFor(() => expect(connectRemote).toHaveBeenCalledTimes(2));
    expect(
      connectRemote.mock.calls.map(([, , context]) => context?.workspacePath).toSorted(),
    ).toEqual([DEFAULT_PATH, DEV_PATH].toSorted());

    unmount();
  });
});
