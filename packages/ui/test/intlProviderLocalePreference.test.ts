// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import {
  resolveLocalePreferenceFromSettings,
  shouldApplyLocaleBroadcastMessage,
  useZCodeIntl,
  ZCodeIntlProvider,
} from "@/i18n/IntlProvider.js";
import type { Locale } from "@zcode/shared";
import type { BroadcastMessage } from "@zcode/services";

function LocaleProbe() {
  const { locale, localePreference } = useZCodeIntl();
  return createElement(
    "div",
    null,
    createElement("span", { "data-testid": "locale" }, locale),
    createElement("span", { "data-testid": "localePreference" }, localePreference),
  );
}

function LocaleControls() {
  const { setLocalePreference } = useZCodeIntl();
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        type: "button",
        onClick: () => setLocalePreference("system"),
      },
      "system",
    ),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => setLocalePreference("en-US"),
      },
      "en-US",
    ),
    createElement(LocaleProbe),
  );
}

function createSettingService(
  settings: { locale: Locale; localePreference: "system" | Locale },
  update = vi.fn().mockResolvedValue(undefined),
) {
  return {
    get: vi.fn().mockResolvedValue(settings),
    update,
  };
}

function renderIntlProvider({
  children,
  settings,
  resolveSystemLocale,
  broadcastService,
  update,
}: {
  children: ReactNode;
  settings: { locale: Locale; localePreference: "system" | Locale };
  resolveSystemLocale?: () => Locale | Promise<Locale>;
  broadcastService?: {
    send: (message: Pick<BroadcastMessage, "channel" | "payload">) => Promise<void>;
    onMessage: (listener: (message: BroadcastMessage) => void) => { dispose: () => void };
  };
  update?: ReturnType<typeof vi.fn>;
}) {
  const settingService = createSettingService(settings, update);
  render(
    createElement(
      ZCodeIntlProvider,
      {
        settingService,
        resolveSystemLocale,
        broadcastService,
      },
      children,
    ),
  );
  return settingService;
}

function installMemoryLocalStorage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        values.delete(key);
      }),
      clear: vi.fn(() => {
        values.clear();
      }),
    },
  });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createBroadcastService() {
  let listener: ((message: BroadcastMessage) => void) | null = null;
  return {
    send: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((nextListener: (message: BroadcastMessage) => void) => {
      listener = nextListener;
      return { dispose: vi.fn() };
    }),
    emit(message: BroadcastMessage) {
      listener?.(message);
    },
  };
}

beforeEach(() => {
  installMemoryLocalStorage();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("IntlProvider locale preference sync", () => {
  it("手机远控以桌面 settingService locale 覆盖手机本地偏好", () => {
    expect(
      resolveLocalePreferenceFromSettings({
        storedPreference: "en-US",
        settingsLocale: "zh-CN",
        settingsLocalePreference: "zh-CN",
        preferSettingServiceLocale: true,
      }),
    ).toBe("zh-CN");
  });

  it("非远控入口继续尊重本地语言偏好", () => {
    expect(
      resolveLocalePreferenceFromSettings({
        storedPreference: "en-US",
        settingsLocale: "zh-CN",
        settingsLocalePreference: "zh-CN",
        preferSettingServiceLocale: false,
      }),
    ).toBe("en-US");
  });

  it("首次启动没有本地偏好时保留 settingService 的 system 偏好", () => {
    expect(
      resolveLocalePreferenceFromSettings({
        storedPreference: null,
        settingsLocale: "zh-CN",
        settingsLocalePreference: "system",
        preferSettingServiceLocale: false,
      }),
    ).toBe("system");
  });

  it("远控入口遇到桌面 system 偏好时使用桌面已解析语言", () => {
    expect(
      resolveLocalePreferenceFromSettings({
        storedPreference: "en-US",
        settingsLocale: "zh-CN",
        settingsLocalePreference: "system",
        preferSettingServiceLocale: true,
      }),
    ).toBe("zh-CN");
  });

  it("只接收 state:locale 的合法语言广播", () => {
    expect(
      shouldApplyLocaleBroadcastMessage({
        channel: "state:locale",
        payload: "zh-CN",
      }),
    ).toBe(true);
    expect(
      shouldApplyLocaleBroadcastMessage({
        channel: "state:theme",
        payload: "zh-CN",
      }),
    ).toBe(false);
    expect(
      shouldApplyLocaleBroadcastMessage({
        channel: "state:locale",
        payload: "fr-FR",
      }),
    ).toBe(false);
    expect(
      shouldApplyLocaleBroadcastMessage({
        channel: "state:locale",
        payload: {
          preference: "system",
          resolvedLocale: "zh-CN",
        },
      }),
    ).toBe(true);
  });

  it("忽略本窗口刚发出的 locale 本地回显，避免覆盖 system 偏好", () => {
    expect(
      shouldApplyLocaleBroadcastMessage(
        {
          channel: "state:locale",
          payload: {
            preference: "system",
            resolvedLocale: "zh-CN",
          },
        },
        {
          ignoredLocalPayload: {
            preference: "system",
            resolvedLocale: "zh-CN",
          },
        },
      ),
    ).toBe(false);
    expect(
      shouldApplyLocaleBroadcastMessage(
        {
          channel: "state:locale",
          payload: {
            preference: "system",
            resolvedLocale: "zh-CN",
          },
          sourceWindowId: 1,
        },
        {
          ignoredLocalPayload: {
            preference: "system",
            resolvedLocale: "zh-CN",
          },
        },
      ),
    ).toBe(true);
  });

  it("桌面 system 偏好优先使用宿主系统语言而不是 renderer navigator.language", async () => {
    Object.defineProperty(navigator, "language", {
      configurable: true,
      value: "en-US",
    });

    const settingService = renderIntlProvider({
      settings: {
        locale: "en-US",
        localePreference: "system",
      },
      resolveSystemLocale: () => Promise.resolve("zh-CN"),
      children: createElement(LocaleProbe),
    });

    await waitFor(() => {
      expect(screen.getByTestId("locale").textContent).toBe("zh-CN");
    });
    expect(screen.getByTestId("localePreference").textContent).toBe("system");
    expect(settingService.update).toHaveBeenCalledWith({
      locale: "zh-CN",
      localePreference: "system",
    });
  });

  it("旧的 system 解析晚返回时不会覆盖后续显式语言选择", async () => {
    const deferredSystemLocale = createDeferred<Locale>();
    const broadcastService = createBroadcastService();
    const settingService = renderIntlProvider({
      settings: {
        locale: "en-US",
        localePreference: "en-US",
      },
      resolveSystemLocale: () => deferredSystemLocale.promise,
      broadcastService,
      children: createElement(LocaleControls),
    });

    await waitFor(() => {
      expect(screen.getByTestId("localePreference").textContent).toBe("en-US");
    });

    fireEvent.click(screen.getByRole("button", { name: "system" }));
    fireEvent.click(screen.getByRole("button", { name: "en-US" }));
    await act(async () => {
      deferredSystemLocale.resolve("zh-CN");
      await deferredSystemLocale.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("locale").textContent).toBe("en-US");
      expect(screen.getByTestId("localePreference").textContent).toBe("en-US");
    });
    expect(localStorage.getItem("zcode-locale-preference")).toBe("en-US");
    expect(settingService.update).toHaveBeenCalledWith({
      locale: "en-US",
      localePreference: "en-US",
    });
    expect(settingService.update).not.toHaveBeenCalledWith({
      locale: "zh-CN",
      localePreference: "system",
    });
    expect(broadcastService.send).toHaveBeenCalledWith({
      channel: "state:locale",
      payload: {
        preference: "en-US",
        resolvedLocale: "en-US",
      },
    });
    expect(broadcastService.send).not.toHaveBeenCalledWith({
      channel: "state:locale",
      payload: {
        preference: "system",
        resolvedLocale: "zh-CN",
      },
    });
  });

  it("跨窗口 system 广播保留偏好并使用解析语言渲染", async () => {
    const broadcastService = createBroadcastService();
    renderIntlProvider({
      settings: {
        locale: "en-US",
        localePreference: "en-US",
      },
      broadcastService,
      children: createElement(LocaleProbe),
    });

    await waitFor(() => {
      expect(screen.getByTestId("localePreference").textContent).toBe("en-US");
    });

    act(() => {
      broadcastService.emit({
        channel: "state:locale",
        payload: {
          preference: "system",
          resolvedLocale: "zh-CN",
        },
        sourceWindowId: 1,
      });
    });

    expect(screen.getByTestId("locale").textContent).toBe("zh-CN");
    expect(screen.getByTestId("localePreference").textContent).toBe("system");
    expect(localStorage.getItem("zcode-locale-preference")).toBe("system");
  });

  it("settingService 持久化延迟时不会阻塞跨窗口广播", async () => {
    const deferredUpdate = createDeferred<void>();
    const update = vi.fn().mockReturnValue(deferredUpdate.promise);
    const broadcastService = createBroadcastService();
    renderIntlProvider({
      settings: {
        locale: "zh-CN",
        localePreference: "zh-CN",
      },
      update,
      broadcastService,
      children: createElement(LocaleControls),
    });

    await waitFor(() => {
      expect(screen.getByTestId("localePreference").textContent).toBe("zh-CN");
    });

    fireEvent.click(screen.getByRole("button", { name: "en-US" }));

    await waitFor(() => {
      expect(screen.getByTestId("locale").textContent).toBe("en-US");
      expect(broadcastService.send).toHaveBeenCalledWith({
        channel: "state:locale",
        payload: {
          preference: "en-US",
          resolvedLocale: "en-US",
        },
      });
    });
    expect(update).toHaveBeenCalledWith({
      locale: "en-US",
      localePreference: "en-US",
    });
  });

  it("初始化 system 解析晚返回时不会覆盖用户刚完成的显式选择", async () => {
    const deferredSystemLocale = createDeferred<Locale>();
    const resolveSystemLocale = vi.fn().mockReturnValue(deferredSystemLocale.promise);
    const update = vi.fn().mockResolvedValue(undefined);
    renderIntlProvider({
      settings: {
        locale: "en-US",
        localePreference: "system",
      },
      resolveSystemLocale,
      update,
      children: createElement(LocaleControls),
    });

    await waitFor(() => {
      expect(resolveSystemLocale).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole("button", { name: "en-US" }));
    await act(async () => {
      deferredSystemLocale.resolve("zh-CN");
      await deferredSystemLocale.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("locale").textContent).toBe("en-US");
      expect(screen.getByTestId("localePreference").textContent).toBe("en-US");
    });
    expect(update).toHaveBeenCalledWith({
      locale: "en-US",
      localePreference: "en-US",
    });
    expect(update).not.toHaveBeenCalledWith({
      locale: "zh-CN",
      localePreference: "system",
    });
  });

  it("首次 settingService update 永久 pending 后再次选择仍会尝试持久化", async () => {
    const pendingUpdate = createDeferred<void>();
    const update = vi
      .fn()
      .mockReturnValueOnce(pendingUpdate.promise)
      .mockResolvedValue(undefined);
    renderIntlProvider({
      settings: {
        locale: "zh-CN",
        localePreference: "zh-CN",
      },
      resolveSystemLocale: () => "zh-CN",
      update,
      children: createElement(LocaleControls),
    });

    await waitFor(() => {
      expect(screen.getByTestId("localePreference").textContent).toBe("zh-CN");
    });

    fireEvent.click(screen.getByRole("button", { name: "en-US" }));
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({
        locale: "en-US",
        localePreference: "en-US",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "system" }));
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({
        locale: "zh-CN",
        localePreference: "system",
      });
    });
    expect(update).toHaveBeenCalledTimes(2);
  });
});
