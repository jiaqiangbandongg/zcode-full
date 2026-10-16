import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IPluginsService } from "@zcode/services";
import { usePluginStore } from "../src/store/pluginStore.js";

function deferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createPluginsServiceMock(overrides?: {
  getOverview?: IPluginsService["getOverview"];
  addMarketplace?: IPluginsService["addMarketplace"];
  removeMarketplace?: IPluginsService["removeMarketplace"];
  updateMarketplace?: IPluginsService["updateMarketplace"];
}): IPluginsService {
  return {
    getOverview:
      overrides?.getOverview ??
      vi.fn(async () => ({
        marketplaces: [],
        availablePlugins: [],
        installedPlugins: [],
        capability: { supported: true },
      })),
    addMarketplace: overrides?.addMarketplace ?? vi.fn(async () => {}),
    removeMarketplace: overrides?.removeMarketplace ?? vi.fn(async () => {}),
    updateMarketplace: overrides?.updateMarketplace ?? vi.fn(async () => {}),
    installPlugin: vi.fn(async () => {}),
    uninstallPlugin: vi.fn(async () => {}),
    setPluginEnabled: vi.fn(async () => {}),
  };
}

describe("pluginStore marketplace operation state", () => {
  beforeEach(() => {
    usePluginStore.setState({
      workspacePath: "/tmp/plugin-workspace",
      workspaceIdentity: null,
      loadedWorkspacePath: "/tmp/plugin-workspace",
      loadedWorkspaceIdentity: null,
      marketplaces: [],
      availablePlugins: [],
      installedPlugins: [],
      capability: { supported: true },
      loading: false,
      refreshing: false,
      error: null,
      addingMarketplaceSource: null,
      removingMarketplaceName: null,
      updatingMarketplaceName: null,
      installingPluginId: null,
      uninstallingPluginId: null,
      settingPluginEnabledId: null,
      settingPluginEnabledValue: null,
    });
  });

  it("refresh 进行中会保留 refreshing 状态，完成后清空", async () => {
    const refreshDeferred = deferredPromise<{
      marketplaces: [];
      availablePlugins: [];
      installedPlugins: [];
      capability: { supported: true };
    }>();
    const service = createPluginsServiceMock({
      getOverview: vi.fn(() => refreshDeferred.promise),
    });

    const pending = usePluginStore.getState().refresh(service);

    expect(usePluginStore.getState().refreshing).toBe(true);

    refreshDeferred.resolve({
      marketplaces: [],
      availablePlugins: [],
      installedPlugins: [],
      capability: { supported: true },
    });
    await pending;

    expect(usePluginStore.getState().refreshing).toBe(false);
  });

  it("initialize 会透传 workspaceIdentity 并记录已加载 identity", async () => {
    const service = createPluginsServiceMock();

    await usePluginStore.getState().initialize(
      "/tmp/plugin-workspace",
      service,
      "remote:ssh:demo-host:22:demo:/tmp/plugin-workspace",
    );

    expect(service.getOverview).toHaveBeenCalledWith({
      workspacePath: "/tmp/plugin-workspace",
      workspaceIdentity: "remote:ssh:demo-host:22:demo:/tmp/plugin-workspace",
    });
    expect(usePluginStore.getState().loadedWorkspaceIdentity).toBe(
      "remote:ssh:demo-host:22:demo:/tmp/plugin-workspace",
    );
  });

  it("addMarketplace 进行中会保留 addingMarketplaceSource，完成后清空", async () => {
    const addDeferred = deferredPromise<void>();
    const service = createPluginsServiceMock({
      addMarketplace: vi.fn(() => addDeferred.promise),
    });

    const pending = usePluginStore
      .getState()
      .addMarketplace("anthropics/claude-plugins-official", service);

    expect(usePluginStore.getState().addingMarketplaceSource).toBe(
      "anthropics/claude-plugins-official",
    );

    addDeferred.resolve();
    await pending;

    expect(usePluginStore.getState().addingMarketplaceSource).toBeNull();
  });

  it("removeMarketplace 进行中会保留 removingMarketplaceName，完成后清空", async () => {
    const removeDeferred = deferredPromise<void>();
    const service = createPluginsServiceMock({
      removeMarketplace: vi.fn(() => removeDeferred.promise),
    });

    const pending = usePluginStore
      .getState()
      .removeMarketplace("anthropic-agent-skills", service);

    expect(usePluginStore.getState().removingMarketplaceName).toBe(
      "anthropic-agent-skills",
    );

    removeDeferred.resolve();
    await pending;

    expect(usePluginStore.getState().removingMarketplaceName).toBeNull();
  });

  it("updateMarketplace 在部分刷新失败时 reload 成功来源并返回 false", async () => {
    const service = createPluginsServiceMock({
      updateMarketplace: vi.fn(async () => ({
        diagnostics: [
          {
            code: "plugin_archive_fetch_failed" as const,
            message: "Archive refresh failed",
            severity: "error" as const,
          },
        ],
        marketplaces: [],
      })),
    });

    const succeeded = await usePluginStore
      .getState()
      .updateMarketplace("claude-plugins-official", service);

    expect(succeeded).toBe(false);
    expect(service.getOverview).toHaveBeenCalledTimes(1);
    expect(usePluginStore.getState().error).toBe("Archive refresh failed");
  });

  it("installPlugin 进行中会保留 installingPluginId，完成后清空", async () => {
    const installDeferred = deferredPromise<void>();
    const service = createPluginsServiceMock();
    service.installPlugin = vi.fn(() => installDeferred.promise);

    const pending = usePluginStore
      .getState()
      .installPlugin("skill-creator", "claude-plugins-official", service);

    expect(usePluginStore.getState().installingPluginId).toBe(
      "user:skill-creator@claude-plugins-official",
    );

    installDeferred.resolve();
    await pending;

    expect(usePluginStore.getState().installingPluginId).toBeNull();
  });

  it("setPluginEnabled 进行中会保留 settingPluginEnabled 状态，完成后清空", async () => {
    const toggleDeferred = deferredPromise<void>();
    const service = createPluginsServiceMock();
    service.setPluginEnabled = vi.fn(() => toggleDeferred.promise);

    const pending = usePluginStore
      .getState()
      .setPluginEnabled("skill-creator", "claude-plugins-official", false, service);

    expect(usePluginStore.getState().settingPluginEnabledId).toBe(
      "user:skill-creator@claude-plugins-official",
    );
    expect(usePluginStore.getState().settingPluginEnabledValue).toBe(false);

    toggleDeferred.resolve();
    await pending;

    expect(usePluginStore.getState().settingPluginEnabledId).toBeNull();
    expect(usePluginStore.getState().settingPluginEnabledValue).toBeNull();
  });
});
