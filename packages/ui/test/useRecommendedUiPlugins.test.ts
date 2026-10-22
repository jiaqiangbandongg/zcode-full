// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRecommendedUiPlugins } from "@/plugin-ui/adapters/useRecommendedUiPlugins.js";

const context = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  recommendations: [] as { pluginId: string; surfaceId: string }[],
  invalidate: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/hooks/useServices.js", () => ({ useServices: () => context.services }));
vi.mock("@/plugin-ui/adapters/useUiPluginRecommendations.js", () => ({
  useUiPluginRecommendations: () => ({ recommendations: context.recommendations, loading: false }),
}));
vi.mock("@/logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/zcodeDraftSkillInvalidation.js", () => ({
  invalidateDeferredDraftSessionForSkillChange: context.invalidate,
}));
vi.mock("@/lib/skillStoreRefresh.js", () => ({
  refreshSharedSkillStoreForWorkspace: context.refresh,
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const id = "panel@zcode-plugins-official";
function setup() {
  let installed = false,
    enabled = false;
  const service = {
    listPlugins: vi.fn(async () => ({
      plugins: installed
        ? [{ id, name: "panel", marketplace: "zcode-plugins-official", enabled }]
        : [],
      diagnostics: [],
    })),
    getPluginsOverview: vi.fn(async () => ({
      marketplaces: [{ id: "zcode-plugins-official" }],
      availablePlugins: [{ id, name: "panel", marketplace: "zcode-plugins-official", installed }],
      installedPlugins: [],
      restorableBuiltins: [],
      diagnostics: [],
    })),
    installPlugin: vi.fn(async () => {
      installed = true;
      return { diagnostics: [] };
    }),
    setPluginEnabled: vi.fn(async () => {
      enabled = true;
      return { diagnostics: [] };
    }),
  };
  context.services = { pluginManagementService: service, skillsService: {} };
  context.recommendations = [
    { pluginId: id, surfaceId: "main" },
    { pluginId: id, surfaceId: "main" },
    { pluginId: "missing@other", surfaceId: "main" },
  ];
  return service;
}
it("未安装和禁用仍展示，复用 user 安装与 workspace 启用，不自动打开", async () => {
  const service = setup();
  const { result } = renderHook(() =>
    useRecommendedUiPlugins({ workspacePath: "/workspace/a", sessionId: "s" }),
  );
  expect(result.current.loading).toBe(true);
  await waitFor(() => expect(result.current.entries).toHaveLength(1));
  expect(result.current.loading).toBe(false);
  expect(result.current.entries[0]!.item.installed).toBe(false);
  await act(async () => result.current.prepare(result.current.entries[0]!.item));
  expect(service.installPlugin).toHaveBeenCalledWith(
    expect.objectContaining({ scope: "user", pluginName: "panel" }),
  );
  expect(result.current.entries[0]!.item.installed).toBe(true);
  await act(async () => result.current.prepare(result.current.entries[0]!.item));
  expect(service.setPluginEnabled).toHaveBeenCalledWith(
    expect.objectContaining({ scope: "workspace", enabled: true }),
  );
  expect(result.current.entries[0]!.item.info?.enabled).toBe(true);
});
it("重复点击只写一次；失败保留推荐并可重试", async () => {
  const service = setup();
  const pending = Promise.withResolvers<{ diagnostics: { severity: string; message: string }[] }>();
  service.installPlugin.mockReturnValueOnce(pending.promise);
  const { result } = renderHook(() =>
    useRecommendedUiPlugins({ workspacePath: "/workspace/a", sessionId: "s" }),
  );
  await waitFor(() => expect(result.current.entries).toHaveLength(1));
  const item = result.current.entries[0]!.item;
  let first: Promise<void>;
  act(() => {
    first = result.current.prepare(item);
    void result.current.prepare(item);
  });
  expect(service.installPlugin).toHaveBeenCalledTimes(1);
  await act(async () => {
    pending.resolve({ diagnostics: [{ severity: "error", message: "denied" }] });
    await first;
  });
  expect(result.current.error).toBe("denied");
  expect(result.current.entries[0]!.item.installed).toBe(false);
  await act(async () => result.current.prepare(item));
  expect(result.current.entries[0]!.item.installed).toBe(true);
});

it("服务切换清空目录，旧操作失败不提示到新服务", async () => {
  const old = setup();
  const pending = Promise.withResolvers<{ diagnostics: { severity: string; message: string }[] }>();
  old.installPlugin.mockReturnValueOnce(pending.promise);
  const { result, rerender } = renderHook(() =>
    useRecommendedUiPlugins({ workspacePath: "/workspace/a", sessionId: "s" }),
  );
  await waitFor(() => expect(result.current.entries).toHaveLength(1));
  let operation: Promise<void>;
  act(() => {
    operation = result.current.prepare(result.current.entries[0]!.item);
  });
  const next = setup();
  rerender();
  expect(result.current.entries).toEqual([]);
  await waitFor(() => expect(next.getPluginsOverview).toHaveBeenCalled());
  await act(async () => {
    pending.resolve({ diagnostics: [{ severity: "error", message: "old failure" }] });
    await operation;
  });
  expect(result.current.error).toBeNull();
  expect(context.invalidate).not.toHaveBeenCalled();
});

it("切换会话后迟到面板不能打开新目标", async () => {
  setup();
  const pending = Promise.withResolvers<never[]>();
  context.services.pluginUiBridgeService = {
    listSurfaces: vi.fn().mockReturnValue(pending.promise),
  };
  const { result, rerender } = renderHook(
    ({ sessionId }) => useRecommendedUiPlugins({ workspacePath: "/workspace/a", sessionId }),
    { initialProps: { sessionId: "old" } },
  );
  await waitFor(() => expect(result.current.entries).toHaveLength(1));
  const request = result.current.resolveSurface(id, "main");
  rerender({ sessionId: "new" });
  rerender({ sessionId: "old" });
  await act(async () => pending.resolve([]));
  expect(await request).toBeUndefined();
});

it.each(["success", "failure"])(
  "不同插件可并发安装，后一次 %s 不清理前一次进度",
  async (outcome) => {
    const service = setup();
    const first = Promise.withResolvers<{ diagnostics: [] }>();
    const second = Promise.withResolvers<{ diagnostics: [] }>();
    service.installPlugin.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderHook(() =>
      useRecommendedUiPlugins({ workspacePath: "/workspace/a", sessionId: "s" }),
    );
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    const a = result.current.entries[0]!.item;
    const b = { ...a, id: "second@zcode-plugins-official", name: "second" };
    let installA!: Promise<void>;
    let installB!: Promise<void>;
    act(() => {
      installA = result.current.prepare(a);
      installB = result.current.prepare(b);
      void result.current.prepare(a);
    });
    expect(service.installPlugin).toHaveBeenCalledTimes(2);
    expect(result.current.isBusy(a)).toBe(true);
    expect(result.current.isBusy(b)).toBe(true);
    await act(async () => {
      if (outcome === "failure") second.reject(new Error("second failed"));
      else second.resolve({ diagnostics: [] });
      await installB;
    });
    expect(result.current.isBusy(a)).toBe(true);
    expect(result.current.isBusy(b)).toBe(false);
    await act(async () => {
      first.resolve({ diagnostics: [] });
      await installA;
    });
    expect(result.current.isBusy(a)).toBe(false);
  },
);

it("新服务可安装同名插件，旧服务完成不清理新操作", async () => {
  const old = setup();
  const oldPending = Promise.withResolvers<{ diagnostics: [] }>();
  old.installPlugin.mockReturnValueOnce(oldPending.promise);
  const { result, rerender } = renderHook(() =>
    useRecommendedUiPlugins({ workspacePath: "/workspace/a", sessionId: "s" }),
  );
  await waitFor(() => expect(result.current.entries).toHaveLength(1));
  let oldOperation!: Promise<void>;
  act(() => {
    oldOperation = result.current.prepare(result.current.entries[0]!.item);
  });
  const next = setup();
  const nextPending = Promise.withResolvers<{ diagnostics: [] }>();
  next.installPlugin.mockReturnValueOnce(nextPending.promise);
  rerender();
  await waitFor(() => expect(result.current.entries).toHaveLength(1));
  const item = result.current.entries[0]!.item;
  let nextOperation!: Promise<void>;
  act(() => {
    nextOperation = result.current.prepare(item);
  });
  expect(next.installPlugin).toHaveBeenCalledTimes(1);
  await act(async () => {
    oldPending.resolve({ diagnostics: [] });
    await oldOperation;
  });
  expect(result.current.isBusy(item)).toBe(true);
  await act(async () => {
    nextPending.resolve({ diagnostics: [] });
    await nextOperation;
  });
  expect(result.current.isBusy(item)).toBe(false);
});

it("安装态刷新后释放按钮，技能刷新不另加推荐区操作锁", async () => {
  setup();
  const refresh = Promise.withResolvers<void>();
  context.refresh.mockReturnValueOnce(refresh.promise);
  const { result } = renderHook(() =>
    useRecommendedUiPlugins({ workspacePath: "/workspace/a", sessionId: "s" }),
  );
  await waitFor(() => expect(result.current.entries).toHaveLength(1));
  const item = result.current.entries[0]!.item;
  let operation!: Promise<void>;
  act(() => {
    operation = result.current.prepare(item);
  });
  await waitFor(() => expect(context.refresh).toHaveBeenCalledTimes(1));
  expect(result.current.entries[0]!.item.installed).toBe(true);
  expect(result.current.isBusy(item)).toBe(false);
  await act(async () => {
    refresh.resolve();
    await operation;
  });
});
