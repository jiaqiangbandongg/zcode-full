// @vitest-environment jsdom
import { act, renderHook, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService, RemoteTarget } from "@zcode/shared";
import { useRemoteWorkspaceHistory } from "@/root/useRemoteWorkspaceHistory.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { createTabStore } from "@/store/tabStore.js";
import zhCN from "@/i18n/locales/zh-CN.js";

afterEach(() => {
  cleanup();
  useRemoteWorkspaceSessionStore.setState({ sessionsById: {} });
});

it.each([false, true])(
  "Host 声明复用：只为新建意图提示实际连接且不覆盖凭据（%s）",
  async (announceReusedConnection) => {
    const reused = true;
    const target: RemoteTarget = { kind: "ssh", host: "actual.example.com", username: "dev" };
    const save = vi.fn(async () => undefined);
    const services = {
      settingService: { get: async () => ({}), update: vi.fn(async () => undefined) },
      credentialService: { load: async () => null, save, delete: vi.fn() },
      fileService: { resolvePath: async ({ path }: { path: string }) => path },
      zcodeTaskService: {
        listPinnedTasks: async () => [],
        listTasks: async () => ({ items: [], total: 0, hasMore: false }),
      },
    } as unknown as IServiceAccessor;
    const sessionId = `session-${reused}`;
    const platform = {
      connectRemote: vi.fn(async () => {
        useRemoteWorkspaceSessionStore.getState().registerSession({ sessionId, target, services });
        return { success: true, sessionId, ...(reused ? { reusedConnectionTarget: target } : {}) };
      }),
      bindRemoteWorkspaceSessionContext: vi.fn(
        async ({ workspacePath }: { workspacePath: string }) => ({
          workspacePath,
          workspaceIdentity: `remote:server:device:${workspacePath}`,
        }),
      ),
      onRemoteConnectionLog: () => () => undefined,
      onRemoteSessionClosed: () => () => undefined,
      onRemoteSessionReconnected: () => () => undefined,
      onBotRemoteWorkspaceReconnected: () => () => undefined,
    } as unknown as IPlatformService;
    const tabStoreApi = createTabStore();
    const { result } = renderHook(() =>
      useRemoteWorkspaceHistory({
        intl: {
          formatMessage: ({ id }, values = {}) =>
            (zhCN[id as keyof typeof zhCN] ?? id).replace(/\{(\w+)\}/gu, (_, key) =>
              String(values[key] ?? `{${key}}`),
            ),
        },
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
      await result.current.handleConnectRemote(
        { ...target, password: "newly-entered-password" },
        undefined,
        undefined,
        { announceReusedConnection },
      );
    });
    if (announceReusedConnection)
      expect(
        await screen.findByText(
          "这台设备已通过 SSH · dev@actual.example.com:22 连接，已直接使用现有连接",
        ),
      ).toBeTruthy();
    else expect(screen.queryByText(/已直接使用现有连接/u)).toBeNull();
    await act(async () => {
      await result.current.handleSelectRemoteProject(sessionId, "/srv/project");
    });
    if (reused) expect(save).not.toHaveBeenCalled();
  },
);
