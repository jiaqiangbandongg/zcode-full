// @vitest-environment jsdom
/**
 * pluginManagementStore 错误归属（lastFailedPluginId）测试。
 *
 * 背景（CR-01，2026-08-19）：store.error 是插件面所有操作共享的字段
 * （marketplace/validate/load/任意插件 setEnabled 失败都会写）。CUA 输入框
 * 按钮曾用 `error && cuaPlugin !== undefined` 误映射——无关插件操作失败也会
 * 把按钮翻成错误态。修复契约：error 写入时同步记录失败操作的目标插件
 * （带 pluginId 的操作写该 id，无插件目标的操作写 null），消费方只认目标为
 * 自己的 error。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { usePluginManagementStore } = await import("@/store/pluginManagementStore.js");

const WORKSPACE = "/tmp/workspace";
const CUA_PLUGIN_ID = "computer-use@zcode-plugins-official";
const OTHER_PLUGIN_ID = "some-other-plugin@mp";

function resetStore(overrides: Record<string, unknown> = {}): void {
  usePluginManagementStore.setState({
    workspacePath: WORKSPACE,
    workspaceIdentity: null,
    plugins: [],
    error: null,
    lastFailedPluginId: null,
    togglingPluginId: null,
    operationId: null,
    ...overrides,
  });
}

function pluginService(overrides: Record<string, unknown> = {}): never {
  return {
    listPlugins: vi.fn(async () => ({ plugins: [], diagnostics: [] })),
    getPluginsOverview: vi.fn(async () => ({
      plugins: [],
      marketplaces: [],
      availablePlugins: [],
      installedPlugins: [],
      restorableBuiltins: [],
      diagnostics: [],
    })),
    setPluginEnabled: vi.fn(async () => {}),
    validatePlugin: vi.fn(async () => ({ diagnostics: [] })),
    ...overrides,
  } as never;
}

beforeEach(() => {
  resetStore();
});

describe("pluginManagementStore 错误归属", () => {
  it("setEnabled 失败记录目标插件 id", async () => {
    const service = pluginService({
      setPluginEnabled: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const ok = await usePluginManagementStore.getState().setEnabled(OTHER_PLUGIN_ID, true, service);
    expect(ok).toBe(false);
    const state = usePluginManagementStore.getState();
    expect(state.error).toContain("boom");
    expect(state.lastFailedPluginId).toBe(OTHER_PLUGIN_ID);
  });

  it("validateSource 失败（无插件目标）记录 null", async () => {
    const service = pluginService({
      validatePlugin: vi.fn(async () => {
        throw new Error("bad source");
      }),
    });
    await usePluginManagementStore.getState().validateSource("https://example.com/mp", service);
    const state = usePluginManagementStore.getState();
    expect(state.error).toContain("bad source");
    expect(state.lastFailedPluginId).toBeNull();
  });

  it("新的成功操作清空 error 与归属", async () => {
    const failing = pluginService({
      setPluginEnabled: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await usePluginManagementStore.getState().setEnabled(CUA_PLUGIN_ID, true, failing);
    expect(usePluginManagementStore.getState().lastFailedPluginId).toBe(CUA_PLUGIN_ID);

    // 下一次操作进入时（任何操作开头）先清空，成功后保持为空。
    const succeeding = pluginService();
    const ok = await usePluginManagementStore
      .getState()
      .setEnabled(CUA_PLUGIN_ID, true, succeeding);
    expect(ok).toBe(true);
    const state = usePluginManagementStore.getState();
    expect(state.error).toBeNull();
    expect(state.lastFailedPluginId).toBeNull();
  });
});
