// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL, type AppSettings } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";

const settingService = {
  get: vi.fn<() => Promise<AppSettings>>(),
  update: vi.fn<(patch: Partial<AppSettings>) => Promise<void>>(),
};
const broadcastService = {
  send: vi.fn<(message: { channel: string; payload: unknown }) => Promise<void>>(),
};
const zcodeAgentService = {
  syncAppRuntimePreferences:
    vi.fn<
      (preferences: {
        askUserQuestionAutoResolutionEnabled: boolean;
        modelIoFullRetentionEnabled: boolean;
      }) => Promise<void>
    >(),
};
const botsService = {
  syncAppRuntimePreferences:
    vi.fn<
      (preferences: {
        askUserQuestionAutoResolutionEnabled: boolean;
        modelIoFullRetentionEnabled: boolean;
      }) => Promise<void>
    >(),
};

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    broadcastService,
    settingService,
    zcodeAgentService,
    botsService,
  }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({}),
}));

describe("useSettings AskUserQuestion runtime preference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingService.get.mockResolvedValue({
      askUserQuestionAutoResolutionEnabled: true,
      modelIoFullRetentionEnabled: false,
    } as AppSettings);
    settingService.update.mockResolvedValue(undefined);
    broadcastService.send.mockResolvedValue(undefined);
    zcodeAgentService.syncAppRuntimePreferences.mockResolvedValue(undefined);
    botsService.syncAppRuntimePreferences.mockResolvedValue(undefined);
  });

  it("账号 CAS 条件透传到设置 owner，冲突拒绝更新", async () => {
    const { useSettings } = await import("@/hooks/useSettingService.js");
    const { result } = renderHook(() => useSettings());
    const expected = {
      providerFamilyDomain: "bigmodel" as const,
      providerFamilyConnectionSelections: {},
    };
    const patch = {
      providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" as const } },
    };
    await act(async () => {
      await result.current.update(patch, expected);
    });
    expect(settingService.update).toHaveBeenCalledWith(patch, expected);
    settingService.get.mockClear();
    settingService.update.mockRejectedValueOnce(new Error("Account connection settings changed"));
    await expect(result.current.update(patch, expected)).rejects.toThrow(
      "Account connection settings changed",
    );
    expect(settingService.get).toHaveBeenCalledOnce();
  });

  it("persists, waits for the current Host ACK, then broadcasts the strict preference", async () => {
    const { useSettings } = await import("@/hooks/useSettingService.js");
    const hook = renderHook(() => useSettings());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    let releaseBotSync: (() => void) | undefined;
    botsService.syncAppRuntimePreferences.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseBotSync = resolve;
      }),
    );

    let updatePromise: Promise<void> | undefined;
    act(() => {
      updatePromise = hook.result.current.update({
        askUserQuestionAutoResolutionEnabled: false,
      });
    });
    await waitFor(() => expect(botsService.syncAppRuntimePreferences).toHaveBeenCalledOnce());
    expect(broadcastService.send).not.toHaveBeenCalled();
    releaseBotSync?.();
    await act(async () => {
      await updatePromise;
    });

    expect(settingService.update).toHaveBeenCalledWith({
      askUserQuestionAutoResolutionEnabled: false,
    });
    expect(zcodeAgentService.syncAppRuntimePreferences).toHaveBeenCalledWith({
      askUserQuestionAutoResolutionEnabled: false,
      modelIoFullRetentionEnabled: false,
    });
    expect(botsService.syncAppRuntimePreferences).toHaveBeenCalledWith({
      askUserQuestionAutoResolutionEnabled: false,
      modelIoFullRetentionEnabled: false,
    });
    expect(broadcastService.send).toHaveBeenCalledWith({
      channel: APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
      payload: {
        askUserQuestionAutoResolutionEnabled: false,
        modelIoFullRetentionEnabled: false,
      },
    });
    expect(zcodeAgentService.syncAppRuntimePreferences.mock.invocationCallOrder[0]).toBeLessThan(
      broadcastService.send.mock.invocationCallOrder[0] ?? 0,
    );
    expect(botsService.syncAppRuntimePreferences.mock.invocationCallOrder[0]).toBeLessThan(
      broadcastService.send.mock.invocationCallOrder[0] ?? 0,
    );

    hook.unmount();
  });

  it("persists and synchronizes ModelIO full retention with the complete preference snapshot", async () => {
    const { useSettings } = await import("@/hooks/useSettingService.js");
    const hook = renderHook(() => useSettings());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    await act(async () => {
      await hook.result.current.update({ modelIoFullRetentionEnabled: true });
    });

    expect(settingService.update).toHaveBeenCalledWith({
      modelIoFullRetentionEnabled: true,
    });
    const preferences = {
      askUserQuestionAutoResolutionEnabled: true,
      modelIoFullRetentionEnabled: true,
    };
    expect(zcodeAgentService.syncAppRuntimePreferences).toHaveBeenCalledWith(preferences);
    expect(botsService.syncAppRuntimePreferences).toHaveBeenCalledWith(preferences);
    expect(broadcastService.send).toHaveBeenCalledWith({
      channel: APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
      payload: preferences,
    });

    hook.unmount();
  });

  it("isolates Source settings snapshots from the local renderer snapshot", async () => {
    const { useSettings } = await import("@/hooks/useSettingService.js");
    settingService.get.mockResolvedValueOnce({ locale: "zh-CN" } as AppSettings);
    const local = renderHook(() => useSettings({ cacheKey: "test-local" }));
    await waitFor(() => expect(local.result.current.loading).toBe(false));

    settingService.get.mockResolvedValueOnce({ locale: "en-US" } as AppSettings);
    const source = renderHook(() => useSettings({ cacheKey: "source:server-a" }));
    await waitFor(() => expect(source.result.current.loading).toBe(false));

    expect(local.result.current.settings?.locale).toBe("zh-CN");
    expect(source.result.current.settings?.locale).toBe("en-US");
    local.unmount();
    source.unmount();
  });

  it("isolates default snapshots by service accessor without requiring every caller to name a cache", async () => {
    const createServices = (locale: "zh-CN" | "en-US") =>
      ({
        broadcastService,
        settingService: {
          get: vi.fn(async () => ({ locale }) as AppSettings),
          update: vi.fn(async () => undefined),
        },
        zcodeAgentService,
        botsService,
      }) as unknown as IServiceAccessor;
    const controllerServices = createServices("zh-CN");
    const sourceServices = createServices("en-US");
    const { useSettings } = await import("@/hooks/useSettingService.js");
    const controller = renderHook(() => useSettings({ services: controllerServices }));
    const source = renderHook(() => useSettings({ services: sourceServices }));

    await waitFor(() => {
      expect(controller.result.current.loading).toBe(false);
      expect(source.result.current.loading).toBe(false);
    });

    expect(controller.result.current.settings?.locale).toBe("zh-CN");
    expect(source.result.current.settings?.locale).toBe("en-US");
    controller.unmount();
    source.unmount();
  });

  it("uses an explicitly injected Controller service instead of the active remote context", async () => {
    const controllerSettingService = {
      get: vi.fn(
        async () =>
          ({
            locale: "zh-CN",
          }) as AppSettings,
      ),
      update: vi.fn(async () => undefined),
    };
    const controllerServices = {
      broadcastService,
      settingService: controllerSettingService,
      zcodeAgentService,
      botsService,
    } as unknown as IServiceAccessor;
    const { useSettings } = await import("@/hooks/useSettingService.js");
    const hook = renderHook(() =>
      useSettings({ cacheKey: "controller-local-test", services: controllerServices }),
    );
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    await act(async () => {
      await hook.result.current.update({ locale: "en-US" });
    });

    expect(controllerSettingService.update).toHaveBeenCalledWith({
      locale: "en-US",
    });
    expect(settingService.update).not.toHaveBeenCalled();
    hook.unmount();
  });

  it("publishes an external Controller update to mounted settings consumers", async () => {
    let current = {
      locale: undefined,
    } as AppSettings;
    settingService.get.mockImplementation(async () => current);
    settingService.update.mockImplementation(async (patch) => {
      current = { ...current, ...patch };
    });
    const { updateSettingsAndRefreshSnapshot, useSettings } =
      await import("@/hooks/useSettingService.js");
    const hook = renderHook(() => useSettings());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    await act(async () => {
      await updateSettingsAndRefreshSnapshot({
        settingService,
        patch: { locale: "zh-CN" },
      });
    });

    expect(hook.result.current.settings?.locale).toBe("zh-CN");
    hook.unmount();
  });
  it("persists ToolSearch mode without synchronizing or broadcasting to active runtimes", async () => {
    const { useSettings } = await import("@/hooks/useSettingService.js");
    const hook = renderHook(() => useSettings());
    await waitFor(() => expect(hook.result.current.loading).toBe(false));

    await act(async () => {
      await hook.result.current.update({ toolSearchMode: "local" });
    });

    expect(settingService.update).toHaveBeenCalledWith({ toolSearchMode: "local" });
    expect(zcodeAgentService.syncAppRuntimePreferences).not.toHaveBeenCalled();
    expect(botsService.syncAppRuntimePreferences).not.toHaveBeenCalled();
    expect(broadcastService.send).not.toHaveBeenCalled();
    hook.unmount();
  });
});
