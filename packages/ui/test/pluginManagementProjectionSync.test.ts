// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import { useCuaComposerEntry } from "@/hooks/useCuaComposerEntry.js";
import type { IPluginManagementService } from "@zcode/services";
import {
  usePluginManagementStore,
  useScopedPluginManagementStore,
} from "@/store/pluginManagementStore.js";
import { refreshWorkspacePluginCapabilitiesAfterRemoteSync } from "@/lib/remotePluginSyncRefresh.js";
import { usePluginUiSurfaces } from "@/plugin-ui/adapters/usePluginUiSurfaces.js";
import {
  getPluginManagementRevision,
  notifyPluginManagementChange,
  subscribePluginManagementChanges,
} from "@/store/pluginManagementStoreLoading.js";

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ openCuaPermissionOnboarding: () => {} }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ pluginManagementService: service, cuaPermissionService: {} }),
  useOptionalServices: () => ({ pluginUiBridgeService: surfaceBridge }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: { computerUseComposerEntryHidden: false } }),
}));
vi.mock("@/hooks/useCuaPermissionStatus.js", () => ({
  useCuaPermissionStatus: () => ({ status: null }),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({ useOptionalTabStore: () => undefined }));

type Store = typeof usePluginManagementStore;
const views = new Map<string, Store>();
const roots: ReturnType<typeof createRoot>[] = [];
let enabled = true;
const surfaceBridge = { listSurfaces: vi.fn(async (_input: unknown) => []) };
let service: IPluginManagementService;
const plugin = () => ({
  id: "panel@example",
  name: "panel",
  enabled,
  source: "directory",
  rootPath: "/cache/panel",
  skillCount: 0,
  skillRootCount: 0,
  commandRootCount: 0,
  mcpServerNames: [],
});

function View({
  name,
  workspacePath,
  workspaceIdentity,
  authorityKey,
  configScope,
}: {
  name: string;
  workspacePath: string;
  workspaceIdentity?: string;
  authorityKey?: string;
  configScope?: "user" | "workspace";
}) {
  const store = useScopedPluginManagementStore(service);
  views.set(name, store);
  useEffect(() => {
    void store.getState().initialize({
      workspacePath,
      workspaceIdentity,
      authorityKey,
      configScope,
      pluginService: service,
    });
  }, [store, workspacePath, workspaceIdentity, authorityKey, configScope]);
  return null;
}
async function mount(
  name: string,
  workspacePath = "/project/a",
  workspaceIdentity?: string,
  configScope?: "user" | "workspace",
  authorityKey?: string,
) {
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  await act(() =>
    root.render(
      createElement(View, { name, workspacePath, workspaceIdentity, authorityKey, configScope }),
    ),
  );
  return views.get(name)!;
}
beforeEach(async () => {
  enabled = true;
  service = {
    listPlugins: vi.fn(async () => ({ plugins: [plugin()], diagnostics: [] })),
    getPluginsOverview: vi.fn(async () => ({
      marketplaces: [],
      availablePlugins: [],
      installedPlugins: [],
      restorableBuiltins: [],
      diagnostics: [],
    })),
    setPluginEnabled: vi.fn(
      async (input: Parameters<IPluginManagementService["setPluginEnabled"]>[0]) => {
        enabled = input.enabled;
        return { plugin: plugin(), enabled };
      },
    ),
  } as unknown as IPluginManagementService;
  usePluginManagementStore.setState({
    workspacePath: null,
    workspaceIdentity: null,
    authorityKey: null,
    configScope: null,
    plugins: [],
    error: null,
    lastFailedPluginId: null,
  });
  await usePluginManagementStore
    .getState()
    .initialize({ workspacePath: "/project/a", pluginService: service });
});
afterEach(async () => {
  for (const root of roots) await act(() => root.unmount());
  roots.length = 0;
  views.clear();
  usePluginManagementStore.setState({ workspacePath: null });
});

it("updates the global projection after a scoped project toggle", async () => {
  const market = await mount("market");
  await act(() => market.getState().setEnabled("panel@example", false, service, "workspace"));
  await vi.waitFor(() =>
    expect(usePluginManagementStore.getState().plugins[0]?.enabled).toBe(false),
  );
});

it("propagates an external refresh to markets without clearing their operation error", async () => {
  const market = await mount("market");
  const pane = await mount("pane");
  market.setState({ error: "configuration failed", lastFailedPluginId: "other@example" });
  enabled = false;
  await act(() => usePluginManagementStore.getState().refresh(service));
  await vi.waitFor(() => {
    expect(market.getState().plugins[0]?.enabled).toBe(false);
    expect(pane.getState().plugins[0]?.enabled).toBe(false);
  });
  expect(market.getState().error).toBe("configuration failed");
  expect(market.getState().lastFailedPluginId).toBe("other@example");
});

it("keeps workspace changes local but invalidates other projects for user changes", async () => {
  const market = await mount("market");
  const other = await mount("other", "/project/b");
  const remote = await mount("remote", "/project/a", "remote:ssh:other.example:22:dev:/project/a");
  vi.mocked(service.listPlugins).mockClear();
  await act(() => market.getState().setEnabled("panel@example", false, service, "workspace"));
  await vi.waitFor(() =>
    expect(usePluginManagementStore.getState().plugins[0]?.enabled).toBe(false),
  );
  expect(other.getState().plugins[0]?.enabled).toBe(true);
  expect(remote.getState().plugins[0]?.enabled).toBe(true);
  expect(
    vi
      .mocked(service.listPlugins)
      .mock.calls.every(
        ([input]) => input.workspacePath === "/project/a" && !input.workspaceIdentity,
      ),
  ).toBe(true);
  await act(() => market.getState().setEnabled("panel@example", false, service, "user"));
  await vi.waitFor(() => expect(other.getState().plugins[0]?.enabled).toBe(false));
  expect(remote.getState().plugins[0]?.enabled).toBe(true);
});

it("shares one background query between equal projections", async () => {
  const writer = await mount("writer", "/project/a", undefined, "user");
  await mount("market");
  await mount("pane");
  vi.mocked(service.getPluginsOverview).mockClear();
  await act(() => writer.getState().setEnabled("panel@example", false, service, "workspace"));
  await vi.waitFor(() => expect(views.get("pane")!.getState().plugins[0]?.enabled).toBe(false));
  expect(service.getPluginsOverview).toHaveBeenCalledTimes(2); // user 写入视图与 effective 投影各一次。
});

it("refreshes a remote market after synchronization even when the global store targets local", async () => {
  const workspaceIdentity = "remote:ssh:host.example:22:dev:/project/a";
  const remote = await mount("remote", "/project/a", workspaceIdentity);
  enabled = false;
  await act(() =>
    refreshWorkspacePluginCapabilitiesAfterRemoteSync({
      workspacePath: "/project/a",
      workspaceIdentity,
      reason: "review-regression",
      zcodeAgentService: {} as never,
      skillsService: { list: vi.fn() } as never,
      commandsService: {
        list: vi.fn(async () => ({
          commands: [],
          userCommands: [],
          pluginCommands: [],
          capability: { userScopeAvailable: true },
        })),
      } as never,
      mcpSyncService: { loadMcpFromUserDirectory: vi.fn(async () => ({ servers: [] })) } as never,
    }),
  );
  expect(remote.getState().plugins[0]?.enabled).toBe(false);
  expect(usePluginManagementStore.getState().plugins[0]?.enabled).toBe(true);
});

it("does not treat a query started before the mutation as the invalidation refresh", async () => {
  const writer = await mount("writer", "/project/a", undefined, "user");
  const pane = await mount("pane");
  let resolveOld!: (value: unknown) => void;
  const old = { plugins: [plugin()], diagnostics: [] };
  vi.mocked(service.listPlugins).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }) as never,
  );
  const pending = pane.getState().refresh(undefined, { background: true });
  const revision = getPluginManagementRevision();
  const mutation = writer.getState().setEnabled("panel@example", false, service, "workspace");
  await vi.waitFor(() => expect(getPluginManagementRevision()).toBeGreaterThan(revision));
  resolveOld(old);
  await act(() => Promise.all([pending, mutation]));
  expect(pane.getState().plugins[0]?.enabled).toBe(false);
});

it("matches Source settings user scope with its remote project projections", async () => {
  const settings = await mount(
    "settings",
    "/home/dev",
    undefined,
    "user",
    "source-settings:server-a",
  );
  const project = await mount("project", "/project/a", "remote:server:server-a:/project/a");
  const other = await mount("other", "/project/a", "remote:server:server-b:/project/a");
  await act(() => settings.getState().setEnabled("panel@example", false, service, "user"));
  expect(project.getState().plugins[0]?.enabled).toBe(false);
  expect(other.getState().plugins[0]?.enabled).toBe(true);
  expect(usePluginManagementStore.getState().plugins[0]?.enabled).toBe(true);
});

it("updates the actual CUA composer entry after a scoped toggle", async () => {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Macintosh" });
  vi.mocked(service.listPlugins).mockImplementation(async () => ({
    plugins: [{ ...plugin(), id: ZCODE_CUA_OFFICIAL_PLUGIN_ID }] as never,
    diagnostics: [],
  }));
  await usePluginManagementStore.getState().refresh(service);
  const entry = renderHook(() => useCuaComposerEntry({ workspacePath: "/project/a" }));
  const market = await mount("market");
  expect(entry.result.current.view.visible).toBe(true);
  await act(() =>
    market.getState().setEnabled(ZCODE_CUA_OFFICIAL_PLUGIN_ID, false, service, "workspace"),
  );
  expect(entry.result.current.view.visible).toBe(false);
  entry.unmount();
});

it("does not let a stuck secondary project keep a successful toggle busy", async () => {
  const writer = await mount("writer");
  await mount("secondary", "/project/b");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(service.listPlugins).mockImplementation(async (input) => {
    if (input.workspacePath === "/project/b") await pending;
    return { plugins: [plugin()] as never, diagnostics: [] };
  });
  let complete = false;
  const operation = writer
    .getState()
    .setEnabled("panel@example", false, service, "user")
    .then(() => {
      complete = true;
    });
  try {
    await vi.waitFor(() => expect(complete).toBe(true));
    expect(writer.getState().togglingPluginId).toBeNull();
  } finally {
    release();
    await act(() => operation);
  }
});

it("completes remote capability refresh while a projection listener is stuck", async () => {
  let release!: () => void;
  const dispose = subscribePluginManagementChanges(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const commands = vi.fn(async () => ({
    commands: [],
    userCommands: [],
    pluginCommands: [],
    capability: { userScopeAvailable: true },
  }));
  const mcp = vi.fn(async () => ({ servers: [] }));
  const operation = refreshWorkspacePluginCapabilitiesAfterRemoteSync({
    workspacePath: "/project/a",
    workspaceIdentity: "remote:server:remote-host:/project/a",
    reason: "review-regression",
    zcodeAgentService: {} as never,
    skillsService: { list: vi.fn() } as never,
    commandsService: { list: commands } as never,
    mcpSyncService: { loadMcpFromUserDirectory: mcp } as never,
  });
  try {
    await vi.waitFor(() => expect(mcp).toHaveBeenCalled());
    expect(commands).toHaveBeenCalled();
  } finally {
    release?.();
    dispose();
    await operation;
  }
});

it("only refreshes surfaces for workspaces affected by a successful change", async () => {
  const a = renderHook(() => usePluginUiSurfaces({ workspacePath: "/project/a" }));
  const b = renderHook(() => usePluginUiSurfaces({ workspacePath: "/project/b" }));
  const remote = renderHook(() =>
    usePluginUiSurfaces({
      workspacePath: "/project/a",
      workspaceIdentity: "remote:server:other:/project/a",
    }),
  );
  await act(async () => {});
  surfaceBridge.listSurfaces.mockClear();
  await act(() =>
    notifyPluginManagementChange({
      workspacePath: "/project/a",
      workspaceIdentity: null,
      authorityKey: null,
      scope: "workspace",
    }),
  );
  expect(surfaceBridge.listSurfaces).toHaveBeenCalledTimes(1);
  expect(surfaceBridge.listSurfaces).toHaveBeenCalledWith({ workspacePath: "/project/a" });
  surfaceBridge.listSurfaces.mockClear();
  await act(() =>
    notifyPluginManagementChange({
      workspacePath: "/project/a",
      workspaceIdentity: null,
      authorityKey: null,
      scope: "user",
    }),
  );
  expect(surfaceBridge.listSurfaces).toHaveBeenCalledTimes(2);
  expect(
    surfaceBridge.listSurfaces.mock.calls.every(
      ([input]) => !(input as { workspaceIdentity?: string }).workspaceIdentity,
    ),
  ).toBe(true);
  a.unmount();
  b.unmount();
  remote.unmount();
});

it("isolates rejected projection refreshes from successful writes", async () => {
  const writer = await mount("writer");
  const dispose = subscribePluginManagementChanges(() =>
    Promise.reject(new Error("secondary disconnected")),
  );
  try {
    await act(async () => {
      expect(await writer.getState().setEnabled("panel@example", false, service, "user")).toBe(
        true,
      );
    });
    expect(writer.getState().error).toBeNull();
    expect(writer.getState().togglingPluginId).toBeNull();
  } finally {
    dispose();
  }
});
