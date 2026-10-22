import { requestRetainedRemoteProjectConnection } from "@/project-sidebar/remote-project-connection.js";
// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService, SourceServerManagementSnapshot } from "@zcode/shared";
import { useRemoteWorkspaceHistory } from "@/root/useRemoteWorkspaceHistory.js";
import { createTabStore } from "@/store/tabStore.js";

const identity = "remote:server:source-1:/srv/project";
const host = {
  id: "remote:server:source-1",
  membershipId: "member-1",
  kind: "ssh",
  position: 0,
  target: { kind: "ssh", host: "dev.example.com", username: "dev" },
};
const entry = {
  id: "entry-1",
  hostId: host.id,
  projectId: "project-1",
  name: "project",
  roots: [{ rootPath: "/srv/project" }],
  legacyWorkspace: null,
  lastSyncedAt: null,
};
const snapshot: SourceServerManagementSnapshot = {
  generation: 1,
  servers: [
    {
      sourceServerId: "source-1",
      displayName: "dev",
      declaredWorkspaces: [],
      preferredProfileId: "profile-1",
    },
  ],
  profiles: [
    {
      profileId: "profile-1",
      sourceServerId: "source-1",
      transport: "ssh",
      createdAt: 1,
      target: {
        kind: "ssh",
        host: "dev.example.com",
        username: "dev",
        assetInstallMode: "remote-download",
      },
    },
  ],
  states: [],
  workspaceHistory: [],
  failedPathCount: 0,
  abandonedPathCount: 0,
  migrationCounts: [],
};
const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});
function setup(connectHost = vi.fn(async () => host)) {
  let directory = { hosts: [host], entries: [entry] };
  const openWizard = vi.fn();
  const services = {
    remoteProjectService: { readDirectory: async () => directory, connectHost },
    sourceServerManagementService: { getSnapshot: async () => snapshot },
    settingService: { get: async () => ({ lastActiveWorkspace: null }), update: async () => {} },
    credentialService: { load: async () => null, save: async () => {}, delete: async () => {} },
  } as unknown as IServiceAccessor;
  const platform = {
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    onRemoteSessionReconnected: () => () => {},
  } as unknown as IPlatformService;
  const tabs = createTabStore();
  const hook = renderHook(() =>
    useRemoteWorkspaceHistory({
      intl: { formatMessage: ({ id }: { id: string }) => id } as never,
      services,
      platform,
      supportsSettings: false,
      isDesktop: true,
      tabStoreApi: tabs,
      activateTabByPath: tabs.getState().activateTabByPath,
      addTab: tabs.getState().addTab,
      onOpenRemoteConnection: openWizard,
    }),
  );
  unmounts.push(hook.unmount);
  return {
    connectHost,
    openWizard,
    tabs,
    connect: () => hook.result.current.handleReconnectRemoteWorkspace(identity),
    setDirectory: (next: typeof directory) => {
      directory = next;
    },
  };
}
it.each([
  "credentials-required",
  "source-server-upgrade-required",
  "source-server-install-required",
])("无导航 tab 的已保存项目将 %s 交给唯一向导", async (code) => {
  const test = setup(
    vi.fn(async () => {
      throw Object.assign(new Error(code), { code });
    }),
  );
  await act(async () => {
    await test.connect();
  });
  expect(test.openWizard).toHaveBeenCalledWith(
    expect.objectContaining({
      preferredDirectoryPath: "/srv/project",
      preferredProjectEntryId: "entry-1",
      preferredProfileId: "profile-1",
      initialFailure: expect.objectContaining({ code }),
    }),
  );
  expect(test.tabs.getState().tabs).toHaveLength(0);
});
it("已保存凭据的未激活项目只恢复设备，不创建导航 tab 或打开向导", async () => {
  const test = setup();
  await act(async () => {
    await test.connect();
  });
  expect(test.connectHost).toHaveBeenCalledWith(host.id);
  expect(test.openWizard).not.toHaveBeenCalled();
  expect(test.tabs.getState().tabs).toHaveLength(0);
});
it.each(["entry", "membership"])(
  "连接期间替换 %s 后，迟到的认证错误不得打开旧项目向导",
  async (removed) => {
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<typeof host>();
    const test = setup(
      vi.fn(() => {
        started.resolve();
        return pending.promise;
      }),
    );
    await act(async () => {
      const connecting = test.connect();
      await started.promise;
      test.setDirectory(
        removed === "entry"
          ? { hosts: [host], entries: [] }
          : { hosts: [{ ...host, membershipId: "replacement" }], entries: [entry] },
      );
      pending.reject(
        Object.assign(new Error("credentials required"), { code: "credentials-required" }),
      );
      await connecting;
    });
    expect(test.connectHost).toHaveBeenCalledOnce();
    expect(test.openWizard).not.toHaveBeenCalled();
  },
);
it("同一项目的并发点击共享既有在途门禁", async () => {
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<typeof host>();
  const test = setup(
    vi.fn(() => {
      started.resolve();
      return pending.promise;
    }),
  );
  await act(async () => {
    const first = test.connect();
    await started.promise;
    await test.connect();
    pending.resolve(host);
    await first;
  });
  expect(test.connectHost).toHaveBeenCalledOnce();
});

it("Direct Server 保持原 Host 连接与错误语义，不交给 Source Profile 向导", async () => {
  const openWizard = vi.fn();
  const connectHost = vi.fn(async () => {
    throw new Error("direct credential unavailable");
  });
  await expect(
    requestRetainedRemoteProjectConnection({
      workspaceKey: identity,
      openWizard,
      service: {
        readDirectory: async () => ({
          hosts: [
            { ...host, kind: "server", target: { kind: "server", url: "https://example.test" } },
          ],
          entries: [entry],
        }),
        connectHost,
      } as never,
    }),
  ).rejects.toThrow("direct credential unavailable");
  expect(connectHost).toHaveBeenCalledOnce();
  expect(openWizard).not.toHaveBeenCalled();
});

it.each(["failed", "needs-install", "needs-upgrade"] as const)(
  "备用线路的 %s 不得替换默认线路或阻止其连接",
  async (state) => {
    const primary = snapshot.profiles[0]!;
    const alternate = { ...primary, profileId: "alternate", target: { ...primary.target } };
    const connectHost = vi.fn(async () => host);
    const openWizard = vi.fn();
    const input = {
      workspaceKey: identity,
      service: {
        readDirectory: async () => ({
          hosts: [{ ...host, lastConnectionError: "alternate connection failed" }],
          entries: [entry],
        }),
        connectHost,
      } as never,
      getSnapshot: async (): Promise<SourceServerManagementSnapshot> => ({
        ...snapshot,
        profiles: [alternate, primary],
        // 默认线路尚无运行态；不能回退读取 Host 聚合的另一线路错误。
        states: [
          { profileId: alternate.profileId, state, error: "alternate failed", updatedAt: 2 },
        ],
      }),
      openWizard,
    };
    await requestRetainedRemoteProjectConnection(input);
    expect(connectHost).toHaveBeenCalledOnce();
    expect(openWizard).not.toHaveBeenCalled();
    connectHost.mockRejectedValueOnce(
      Object.assign(new Error("password required"), { code: "credentials-required" }),
    );
    await requestRetainedRemoteProjectConnection(input);
    expect(openWizard).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredProfileId: primary.profileId,
        preferredProjectEntryId: entry.id,
      }),
    );
  },
);
