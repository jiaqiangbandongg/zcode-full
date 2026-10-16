import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodePluginsOverviewResult, ZCodePluginInfo } from "@zcode/shared";
import type { IPluginManagementService } from "@zcode/services";
import { usePluginManagementStore } from "../src/store/pluginManagementStore.js";
import { buildStoreItems } from "../src/settings/pluginStoreListing.js";

function makePlugin(overrides: Partial<ZCodePluginInfo> = {}): ZCodePluginInfo {
  return {
    id: "skill-creator@zcode-plugins-official",
    name: "skill-creator",
    enabled: true,
    source: "official",
    marketplace: "zcode-plugins-official",
    skillCount: 1,
    skillRootCount: 1,
    commandRootCount: 0,
    mcpServerNames: [],
    rootPath: "/cache/skill-creator",
    ...overrides,
  };
}

function createPluginServiceMock(overrides?: {
  getPluginsOverview?: IPluginManagementService["getPluginsOverview"];
  listPlugins?: IPluginManagementService["listPlugins"];
  addPluginMarketplace?: IPluginManagementService["addPluginMarketplace"];
  updatePluginMarketplace?: IPluginManagementService["updatePluginMarketplace"];
  installPlugin?: IPluginManagementService["installPlugin"];
  updatePlugin?: IPluginManagementService["updatePlugin"];
  configurePlugin?: IPluginManagementService["configurePlugin"];
  setPluginEnabled?: IPluginManagementService["setPluginEnabled"];
}): IPluginManagementService {
  return {
    getPluginsOverview: overrides?.getPluginsOverview ?? vi.fn(async () => makeOverview()),
    listPlugins:
      overrides?.listPlugins ?? vi.fn(async () => ({ plugins: [makePlugin()], diagnostics: [] })),
    addPluginMarketplace:
      overrides?.addPluginMarketplace ?? vi.fn(async () => ({ diagnostics: [] })),
    updatePluginMarketplace:
      overrides?.updatePluginMarketplace ?? vi.fn(async () => ({ diagnostics: [] })),
    installPlugin:
      overrides?.installPlugin ??
      vi.fn(async () => ({ installedPlugins: [], dependencyClosure: [], diagnostics: [] })),
    updatePlugin:
      overrides?.updatePlugin ??
      vi.fn(async () => ({ installedPlugins: [], dependencyClosure: [], diagnostics: [] })),
    configurePlugin:
      overrides?.configurePlugin ??
      vi.fn(async () => ({ pluginId: "skill-creator@zcode-plugins-official", diagnostics: [] })),
    setPluginEnabled:
      overrides?.setPluginEnabled ??
      vi.fn(async () => ({ plugin: makePlugin({ enabled: false }), enabled: false })),
  } as unknown as IPluginManagementService;
}

function makeOverview(
  overrides: Partial<ZCodePluginsOverviewResult> = {},
): ZCodePluginsOverviewResult {
  return {
    marketplaces: [
      {
        id: "claude-plugins-official",
        name: "claude-plugins-official",
        source: { source: "github", repo: "anthropics/claude-plugins" },
        pluginCount: 1,
      },
    ],
    availablePlugins: [
      {
        id: "skill-creator@claude-plugins-official",
        name: "skill-creator",
        marketplace: "claude-plugins-official",
        installed: false,
      },
    ],
    installedPlugins: [],
    diagnostics: [],
    capability: { supported: true },
    ...overrides,
  };
}

beforeEach(() => {
  usePluginManagementStore.setState({
    workspacePath: null,
    workspaceIdentity: null,
    configScope: null,
    plugins: [],
    marketplaces: [],
    marketplaceAvailabilityKnown: false,
    availablePlugins: [],
    installedPlugins: [],
    diagnostics: [],
    loading: false,
    error: null,
    togglingPluginId: null,
    operationId: null,
    describeCache: {},
  });
});

describe("pluginManagementStore", () => {
  it("initialize loads plugins from the agent service", async () => {
    const pluginService = createPluginServiceMock();

    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });

    const state = usePluginManagementStore.getState();
    expect(state.plugins.map((plugin) => plugin.name)).toEqual(["skill-creator"]);
    expect(state.marketplaces.map((marketplace) => marketplace.id)).toEqual([
      "claude-plugins-official",
    ]);
    expect(state.marketplaceAvailabilityKnown).toBe(true);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
    expect(pluginService.listPlugins).toHaveBeenCalledWith({ workspacePath: "/workspace/app" });
    expect(pluginService.getPluginsOverview).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
    });
  });

  it("binds list and overview requests to the selected configuration scope", async () => {
    const pluginService = createPluginServiceMock();

    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      workspaceIdentity: "remote:ssh:host-a:22:user:/workspace/app",
      configScope: "workspace",
      pluginService,
    });

    expect(pluginService.listPlugins).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
      workspaceIdentity: "remote:ssh:host-a:22:user:/workspace/app",
      configScope: "workspace",
    });
    expect(pluginService.getPluginsOverview).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
      workspaceIdentity: "remote:ssh:host-a:22:user:/workspace/app",
      configScope: "workspace",
    });
    expect(usePluginManagementStore.getState().configScope).toBe("workspace");
  });

  it("does not join User and Workspace loads for the same workspace identity", async () => {
    const pending = new Map<string, () => void>();
    const listPlugins = vi.fn(
      ({ configScope }: { configScope?: "user" | "workspace" }) =>
        new Promise<{ plugins: ZCodePluginInfo[]; diagnostics: [] }>((resolve) => {
          pending.set(configScope ?? "effective", () =>
            resolve({
              plugins: [
                makePlugin({
                  name: configScope === "user" ? "user-view" : "workspace-view",
                }),
              ],
              diagnostics: [],
            }),
          );
        }),
    );
    const pluginService = createPluginServiceMock({
      listPlugins: listPlugins as unknown as IPluginManagementService["listPlugins"],
    });

    const userLoad = usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      configScope: "user",
      pluginService,
    });
    const workspaceLoad = usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      configScope: "workspace",
      pluginService,
    });

    pending.get("user")?.();
    pending.get("workspace")?.();
    await Promise.all([userLoad, workspaceLoad]);

    expect(listPlugins).toHaveBeenCalledTimes(2);
    expect(usePluginManagementStore.getState().plugins[0]?.name).toBe("workspace-view");
  });

  it("keeps marketplace availability unknown when overview fails but list fallback succeeds", async () => {
    const fallbackPlugin = makePlugin({
      id: "personal@personal-market",
      name: "personal",
      source: "cache",
      marketplace: "personal-market",
    });
    const listPlugins = vi.fn(async () => ({
      plugins: [fallbackPlugin],
      diagnostics: [],
    }));
    const pluginService = createPluginServiceMock({
      listPlugins: listPlugins as unknown as IPluginManagementService["listPlugins"],
      getPluginsOverview: vi.fn(async () => {
        throw new Error("overview timeout");
      }) as unknown as IPluginManagementService["getPluginsOverview"],
    });

    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });

    const state = usePluginManagementStore.getState();
    const [item] = buildStoreItems({
      marketplaces: state.marketplaces,
      marketplaceAvailabilityKnown: state.marketplaceAvailabilityKnown,
      availablePlugins: state.availablePlugins,
      installedPlugins: state.installedPlugins,
      plugins: state.plugins,
      restorableBuiltins: state.restorableBuiltins,
    });
    expect(listPlugins).toHaveBeenCalledTimes(2);
    expect(state.marketplaceAvailabilityKnown).toBe(false);
    expect(item).toMatchObject({
      id: "personal@personal-market",
      orphaned: false,
    });
  });

  it("setEnabled toggles via the service then re-lists", async () => {
    const listPlugins = vi
      .fn()
      .mockResolvedValueOnce({ plugins: [makePlugin({ enabled: true })], diagnostics: [] })
      .mockResolvedValueOnce({ plugins: [makePlugin({ enabled: false })], diagnostics: [] });
    const setPluginEnabled = vi.fn(async () => ({
      plugin: makePlugin({ enabled: false }),
      enabled: false,
    }));
    const getPluginsOverview = vi.fn(async () => makeOverview());
    const pluginService = createPluginServiceMock({
      getPluginsOverview:
        getPluginsOverview as unknown as IPluginManagementService["getPluginsOverview"],
      listPlugins: listPlugins as unknown as IPluginManagementService["listPlugins"],
      setPluginEnabled: setPluginEnabled as unknown as IPluginManagementService["setPluginEnabled"],
    });

    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });
    await usePluginManagementStore
      .getState()
      .setEnabled("skill-creator@zcode-plugins-official", false, pluginService);

    expect(setPluginEnabled).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
      pluginId: "skill-creator@zcode-plugins-official",
      enabled: false,
      scope: "user",
    });
    const state = usePluginManagementStore.getState();
    expect(state.plugins[0]?.enabled).toBe(false);
    expect(state.togglingPluginId).toBeNull();
  });

  it("projects the toggle immediately while the write is pending and restores it on failure", async () => {
    let rejectWrite: ((error: Error) => void) | undefined;
    const setPluginEnabled = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          rejectWrite = reject;
        }),
    );
    const pluginService = createPluginServiceMock({
      setPluginEnabled: setPluginEnabled as unknown as IPluginManagementService["setPluginEnabled"],
    });

    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      configScope: "workspace",
      pluginService,
    });

    const change = usePluginManagementStore
      .getState()
      .setEnabled("skill-creator@zcode-plugins-official", false, pluginService, "workspace");

    expect(usePluginManagementStore.getState().plugins[0]).toMatchObject({
      enabled: false,
      enabledSource: "workspace",
    });
    expect(usePluginManagementStore.getState().togglingPluginId).toBe(
      "skill-creator@zcode-plugins-official",
    );

    rejectWrite?.(new Error("write failed"));
    await expect(change).resolves.toBe(false);

    expect(usePluginManagementStore.getState().plugins[0]).toMatchObject({
      enabled: true,
    });
    expect(usePluginManagementStore.getState().plugins[0]?.enabledSource).toBeUndefined();
    expect(usePluginManagementStore.getState().togglingPluginId).toBeNull();
    expect(usePluginManagementStore.getState().error).toBe("write failed");
  });

  it("ignores a stale toggle response after the selected configuration scope changes", async () => {
    let resolveWrite: ((value: { plugin: ZCodePluginInfo; enabled: boolean }) => void) | undefined;
    const setPluginEnabled = vi.fn(
      () =>
        new Promise<{ plugin: ZCodePluginInfo; enabled: boolean }>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const pluginService = createPluginServiceMock({
      setPluginEnabled: setPluginEnabled as unknown as IPluginManagementService["setPluginEnabled"],
    });

    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/a",
      configScope: "workspace",
      pluginService,
    });
    const change = usePluginManagementStore
      .getState()
      .setEnabled("skill-creator@zcode-plugins-official", false, pluginService, "workspace");

    usePluginManagementStore.setState({
      workspacePath: "/workspace/b",
      workspaceIdentity: null,
      configScope: "workspace",
      togglingPluginId: "another-plugin@market",
    });
    resolveWrite?.({ plugin: makePlugin({ enabled: false }), enabled: false });

    await expect(change).resolves.toBe(false);
    expect(usePluginManagementStore.getState().workspacePath).toBe("/workspace/b");
    expect(usePluginManagementStore.getState().togglingPluginId).toBe("another-plugin@market");
  });

  it("adds a marketplace through the agent service and refreshes overview", async () => {
    const addPluginMarketplace = vi.fn(async () => ({ diagnostics: [] }));
    const getPluginsOverview = vi
      .fn()
      .mockResolvedValueOnce(makeOverview({ marketplaces: [] }))
      .mockResolvedValueOnce(makeOverview());
    const pluginService = createPluginServiceMock({
      addPluginMarketplace:
        addPluginMarketplace as unknown as IPluginManagementService["addPluginMarketplace"],
      getPluginsOverview:
        getPluginsOverview as unknown as IPluginManagementService["getPluginsOverview"],
    });

    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });
    await usePluginManagementStore
      .getState()
      .addMarketplace("anthropics/claude-plugins", pluginService);

    expect(addPluginMarketplace).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
      source: "anthropics/claude-plugins",
    });
    expect(usePluginManagementStore.getState().marketplaces.map((item) => item.id)).toEqual([
      "claude-plugins-official",
    ]);
    expect(usePluginManagementStore.getState().operationId).toBeNull();
  });

  // 回归：addMarketplace 必须返回 boolean。popover 依赖它决定成功后清空输入并关闭，失败则保留输入不误关。
  it("resolves true after a successful marketplace add", async () => {
    const addPluginMarketplace = vi.fn(async () => ({ diagnostics: [] }));
    const getPluginsOverview = vi
      .fn()
      .mockResolvedValueOnce(makeOverview({ marketplaces: [] }))
      .mockResolvedValueOnce(makeOverview());
    const pluginService = createPluginServiceMock({
      addPluginMarketplace:
        addPluginMarketplace as unknown as IPluginManagementService["addPluginMarketplace"],
      getPluginsOverview:
        getPluginsOverview as unknown as IPluginManagementService["getPluginsOverview"],
    });

    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });
    const added = await usePluginManagementStore
      .getState()
      .addMarketplace("anthropics/claude-plugins", pluginService);

    expect(added).toBe(true);
    expect(usePluginManagementStore.getState().error).toBeNull();
    expect(usePluginManagementStore.getState().operationId).toBeNull();
  });

  it("keeps a successful marketplace add from becoming stale when refresh overlaps it", async () => {
    let resolveAdd: (() => void) | undefined;
    let resolveRefresh: (() => void) | undefined;
    const addPluginMarketplace = vi.fn(
      () =>
        new Promise<{ diagnostics: [] }>((resolve) => {
          resolveAdd = () => resolve({ diagnostics: [] });
        }),
    );
    const updatePluginMarketplace = vi.fn(
      () =>
        new Promise<{ diagnostics: [] }>((resolve) => {
          resolveRefresh = () => resolve({ diagnostics: [] });
        }),
    );
    const pluginService = createPluginServiceMock({
      addPluginMarketplace:
        addPluginMarketplace as unknown as IPluginManagementService["addPluginMarketplace"],
      updatePluginMarketplace:
        updatePluginMarketplace as unknown as IPluginManagementService["updatePluginMarketplace"],
    });

    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });

    const addPromise = usePluginManagementStore
      .getState()
      .addMarketplace("anthropics/claude-plugins", pluginService);
    await vi.waitFor(() => expect(addPluginMarketplace).toHaveBeenCalledTimes(1));

    const refreshPromise = usePluginManagementStore
      .getState()
      .updateMarketplace("claude-plugins-official", pluginService);
    await vi.waitFor(() => expect(updatePluginMarketplace).toHaveBeenCalledTimes(1));

    resolveAdd?.();
    await Promise.resolve();
    resolveRefresh?.();

    await expect(addPromise).resolves.toBe(true);
    await expect(refreshPromise).resolves.toBe(true);
  });

  // 回归：失败分支返回 false 并把错误写进 state.error；operationId 复位。
  // 这正是 popover「保留输入 + 不关闭 + 展示上方错误」赖以工作的契约。
  it("resolves false and records the error when marketplace add fails", async () => {
    const addPluginMarketplace = vi.fn(async () => {
      throw new Error("bad source");
    });
    const getPluginsOverview = vi.fn(async () => makeOverview({ marketplaces: [] }));
    const pluginService = createPluginServiceMock({
      addPluginMarketplace:
        addPluginMarketplace as unknown as IPluginManagementService["addPluginMarketplace"],
      getPluginsOverview:
        getPluginsOverview as unknown as IPluginManagementService["getPluginsOverview"],
    });

    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });
    const added = await usePluginManagementStore
      .getState()
      .addMarketplace("not-a-real-source", pluginService);

    expect(added).toBe(false);
    expect(usePluginManagementStore.getState().error).toBe("bad source");
    expect(usePluginManagementStore.getState().operationId).toBeNull();
  });

  it("reports a partial marketplace refresh failure after reloading successful sources", async () => {
    const failure = {
      code: "plugin_archive_fetch_failed",
      failedAt: "2026-08-06T03:55:00.000Z",
      message: "Archive download timed out",
    };
    const updatePluginMarketplace = vi.fn(async () => ({
      diagnostics: [{ ...failure, severity: "error" as const }],
    }));
    const getPluginsOverview = vi
      .fn()
      .mockResolvedValueOnce(makeOverview())
      .mockResolvedValueOnce(
        makeOverview({
          marketplaces: [
            {
              ...makeOverview().marketplaces[0]!,
              refreshFailure: failure,
            },
          ],
          diagnostics: [{ ...failure, severity: "error" as const }],
        }),
      );
    const pluginService = createPluginServiceMock({
      updatePluginMarketplace:
        updatePluginMarketplace as unknown as IPluginManagementService["updatePluginMarketplace"],
      getPluginsOverview:
        getPluginsOverview as unknown as IPluginManagementService["getPluginsOverview"],
    });

    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });
    const updated = await usePluginManagementStore
      .getState()
      .updateMarketplace(null, pluginService);

    const state = usePluginManagementStore.getState();
    expect(updated).toBe(false);
    expect(state.error).toBe("Archive download timed out");
    expect(state.marketplaces[0]?.refreshFailure).toEqual(failure);
    expect(state.operationId).toBeNull();
  });

  // 回归：claude-plugins-official 是 GitHub git 源，其刷新失败（任何原因）不再写入 state.error，
  // 顶栏刷新与来源对话框都不应弹错误；其它市场的失败语义保持不变。
  it("ignores claude-plugins-official refresh failures when reporting refresh errors", async () => {
    const updatePluginMarketplace = vi.fn(async () => ({
      diagnostics: [
        {
          code: "plugin_marketplace_invalid",
          message: "git clone failed: could not resolve host github.com",
          pluginId: "claude-plugins-official",
          severity: "error" as const,
        },
      ],
    }));
    const pluginService = createPluginServiceMock({
      updatePluginMarketplace:
        updatePluginMarketplace as unknown as IPluginManagementService["updatePluginMarketplace"],
    });

    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });
    const updated = await usePluginManagementStore
      .getState()
      .updateMarketplace(null, pluginService);

    expect(updated).toBe(true);
    expect(usePluginManagementStore.getState().error).toBeNull();
  });

  // 回归：没有 workspacePath 时不应发起调用，且返回 false（popover 不应误判为成功）。
  it("resolves false without calling the agent when no workspace is selected", async () => {
    const addPluginMarketplace = vi.fn(async () => ({ diagnostics: [] }));
    const pluginService = createPluginServiceMock({
      addPluginMarketplace:
        addPluginMarketplace as unknown as IPluginManagementService["addPluginMarketplace"],
    });

    // 不调用 initialize -> workspacePath 为空。
    const added = await usePluginManagementStore
      .getState()
      .addMarketplace("anthropics/claude-plugins", pluginService);

    expect(added).toBe(false);
    expect(addPluginMarketplace).not.toHaveBeenCalled();
  });

  it("records an error when listing fails", async () => {
    const pluginService = createPluginServiceMock({
      listPlugins: vi.fn(async () => {
        throw new Error("boom");
      }) as unknown as IPluginManagementService["listPlugins"],
      getPluginsOverview: vi.fn(async () =>
        makeOverview(),
      ) as unknown as IPluginManagementService["getPluginsOverview"],
    });

    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });

    const state = usePluginManagementStore.getState();
    expect(state.error).toBe("boom");
    expect(state.loading).toBe(false);
    expect(state.plugins).toEqual([]);
  });

  it("maps an install error diagnostic to the recoverable operation error", async () => {
    const installPlugin = vi.fn(async () => ({
      installedPlugins: [],
      dependencyClosure: [],
      diagnostics: [
        {
          code: "plugin_not_found",
          message: "Plugin not found: fixture@personal",
          severity: "error" as const,
        },
      ],
    }));
    const pluginService = createPluginServiceMock({
      installPlugin: installPlugin as unknown as IPluginManagementService["installPlugin"],
    });
    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });

    await usePluginManagementStore.getState().installPlugin("fixture", "personal", pluginService);

    expect(usePluginManagementStore.getState().error).toBe("Plugin not found: fixture@personal");
    expect(usePluginManagementStore.getState().installedPlugins).toEqual([]);
    expect(usePluginManagementStore.getState().operationId).toBeNull();
  });

  it("forwards Workspace scope when installing from the Workspace plugin store", async () => {
    const installPlugin = vi.fn(async () => ({
      installedPlugins: [],
      dependencyClosure: [],
      diagnostics: [],
    }));
    const pluginService = createPluginServiceMock({
      installPlugin: installPlugin as unknown as IPluginManagementService["installPlugin"],
    });
    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });

    await usePluginManagementStore
      .getState()
      .installPlugin("fixture", "personal", pluginService, "workspace");

    expect(installPlugin).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
      pluginName: "fixture",
      marketplace: "personal",
      scope: "workspace",
    });
  });

  it("forwards sensitive option clears without resetting other plugin state", async () => {
    const configurePlugin = vi.fn(async () => ({
      pluginId: "skill-creator@zcode-plugins-official",
      diagnostics: [],
    }));
    const pluginService = createPluginServiceMock({
      configurePlugin: configurePlugin as unknown as IPluginManagementService["configurePlugin"],
    });
    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });

    const configured = await usePluginManagementStore
      .getState()
      .configurePlugin(
        "skill-creator@zcode-plugins-official",
        { region: "us-east-1" },
        pluginService,
        "workspace",
        ["token"],
      );

    expect(configured).toBe(true);
    expect(configurePlugin).toHaveBeenCalledWith({
      workspacePath: "/workspace/app",
      pluginId: "skill-creator@zcode-plugins-official",
      options: { region: "us-east-1" },
      scope: "workspace",
      clearOptionKeys: ["token"],
    });
  });

  it("returns false and keeps a retryable error when plugin configuration fails", async () => {
    const configurePlugin = vi.fn(async () => {
      throw new Error("remote workspace disconnected");
    });
    const pluginService = createPluginServiceMock({
      configurePlugin: configurePlugin as unknown as IPluginManagementService["configurePlugin"],
    });
    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });

    const configured = await usePluginManagementStore
      .getState()
      .configurePlugin("skill-creator@zcode-plugins-official", {}, pluginService, "workspace", [
        "token",
      ]);

    expect(configured).toBe(false);
    expect(usePluginManagementStore.getState().error).toBe("remote workspace disconnected");
    expect(usePluginManagementStore.getState().operationId).toBeNull();
  });

  it("clears a completed configuration operation after the selected scope changes", async () => {
    let resolveConfiguration: (() => void) | undefined;
    const configurePlugin = vi.fn(
      () =>
        new Promise<{ pluginId: string; diagnostics: [] }>((resolve) => {
          resolveConfiguration = () =>
            resolve({
              pluginId: "skill-creator@zcode-plugins-official",
              diagnostics: [],
            });
        }),
    );
    const pluginService = createPluginServiceMock({
      configurePlugin: configurePlugin as unknown as IPluginManagementService["configurePlugin"],
    });
    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      configScope: "user",
      pluginService,
    });

    const configuration = usePluginManagementStore
      .getState()
      .configurePlugin("skill-creator@zcode-plugins-official", { label: "user" }, pluginService);
    await vi.waitFor(() => expect(configurePlugin).toHaveBeenCalledTimes(1));
    expect(usePluginManagementStore.getState().operationId).toBe(
      "plugin:configure:skill-creator@zcode-plugins-official",
    );

    usePluginManagementStore.setState({ configScope: "workspace" });
    resolveConfiguration?.();

    await expect(configuration).resolves.toBe(false);
    expect(usePluginManagementStore.getState().operationId).toBeNull();
  });

  it("does not carry a previous scope operation into a newly initialized scope", async () => {
    let resolveConfiguration: (() => void) | undefined;
    const configurePlugin = vi.fn(
      () =>
        new Promise<{ pluginId: string; diagnostics: [] }>((resolve) => {
          resolveConfiguration = () =>
            resolve({
              pluginId: "skill-creator@zcode-plugins-official",
              diagnostics: [],
            });
        }),
    );
    const pluginService = createPluginServiceMock({
      configurePlugin: configurePlugin as unknown as IPluginManagementService["configurePlugin"],
    });
    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      configScope: "user",
      pluginService,
    });

    const userConfiguration = usePluginManagementStore
      .getState()
      .configurePlugin("skill-creator@zcode-plugins-official", { label: "user" }, pluginService);
    await vi.waitFor(() => expect(configurePlugin).toHaveBeenCalledTimes(1));

    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      configScope: "workspace",
      pluginService,
    });

    expect(usePluginManagementStore.getState().operationId).toBeNull();
    resolveConfiguration?.();
    await expect(userConfiguration).resolves.toBe(false);
    expect(usePluginManagementStore.getState().operationId).toBeNull();
  });

  it("keeps the old version and update badge when update returns an error diagnostic", async () => {
    const installedPlugin = {
      id: "fixture@personal",
      name: "fixture",
      marketplace: "personal",
      version: "1.0.0",
      latestVersion: "2.0.0",
      updateStatus: "update-available" as const,
      enabled: true,
      scope: "user" as const,
    };
    const updatePlugin = vi.fn(async () => ({
      installedPlugins: [],
      dependencyClosure: [],
      diagnostics: [
        {
          code: "plugin_marketplace_invalid",
          message: "Marketplace source is missing",
          severity: "error" as const,
        },
      ],
    }));
    const pluginService = createPluginServiceMock({
      getPluginsOverview: vi.fn(async () =>
        makeOverview({ installedPlugins: [installedPlugin] }),
      ) as unknown as IPluginManagementService["getPluginsOverview"],
      updatePlugin: updatePlugin as unknown as IPluginManagementService["updatePlugin"],
    });
    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });

    await usePluginManagementStore.getState().updatePlugin("fixture@personal", pluginService);

    expect(usePluginManagementStore.getState().error).toBe("Marketplace source is missing");
    expect(usePluginManagementStore.getState().installedPlugins).toEqual([installedPlugin]);
    expect(usePluginManagementStore.getState().operationId).toBeNull();
  });

  it("maps an empty describe result with an error diagnostic to a retryable state", async () => {
    const pluginService = createPluginServiceMock();
    pluginService.describePlugin = vi.fn(async () => ({
      components: [],
      diagnostics: [
        {
          code: "plugin_source_invalid",
          message: "plugin source is missing",
          severity: "error" as const,
        },
      ],
    }));
    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });

    await usePluginManagementStore
      .getState()
      .describePlugin("fixture@personal", "fixture", "personal", pluginService);

    expect(usePluginManagementStore.getState().describeCache["fixture@personal"]).toEqual({
      status: "error",
      error: "plugin source is missing",
    });
  });

  it("keeps a partially described plugin loaded when components are available", async () => {
    const pluginService = createPluginServiceMock();
    pluginService.describePlugin = vi.fn(async () => ({
      components: [{ kind: "skill" as const, items: [{ name: "fixture-skill" }] }],
      diagnostics: [
        {
          code: "plugin_component_partial",
          message: "one optional component is missing",
          severity: "error" as const,
        },
      ],
    }));
    await usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });

    await usePluginManagementStore
      .getState()
      .describePlugin("fixture@personal", "fixture", "personal", pluginService);

    expect(usePluginManagementStore.getState().describeCache["fixture@personal"]?.status).toBe(
      "loaded",
    );
  });

  it("reuses an in-flight load for the same workspace", async () => {
    let resolveList: ((value: { plugins: ZCodePluginInfo[]; diagnostics: [] }) => void) | undefined;
    const listPlugins = vi.fn(
      () =>
        new Promise<{ plugins: ZCodePluginInfo[]; diagnostics: [] }>((resolve) => {
          resolveList = resolve;
        }),
    );
    const getPluginsOverview = vi.fn(async () => makeOverview());
    const pluginService = createPluginServiceMock({
      getPluginsOverview:
        getPluginsOverview as unknown as IPluginManagementService["getPluginsOverview"],
      listPlugins: listPlugins as unknown as IPluginManagementService["listPlugins"],
    });

    const first = usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });
    const second = usePluginManagementStore.getState().initialize({
      workspacePath: "/workspace/app",
      pluginService,
    });

    expect(listPlugins).toHaveBeenCalledTimes(1);
    resolveList?.({ plugins: [makePlugin()], diagnostics: [] });
    await Promise.all([first, second]);

    const state = usePluginManagementStore.getState();
    expect(state.plugins.map((plugin) => plugin.name)).toEqual(["skill-creator"]);
    expect(state.loading).toBe(false);
  });
});
