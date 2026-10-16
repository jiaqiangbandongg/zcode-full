import { afterEach, describe, expect, it, vi } from "vitest";

async function loadSettingsNavigation(env: "test" | "production") {
  vi.resetModules();
  vi.doMock("@zcode/shared", async () => {
    const actual =
      await vi.importActual<typeof import("@zcode/shared")>("@zcode/shared");
    return {
      ...actual,
      ZCODE_ENV: env,
    };
  });

  return import("../src/lib/settingsNavigation.js");
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("settingsNavigation", () => {
  it("在 test 环境保留 usage 分区", async () => {
    const navigation = await loadSettingsNavigation("test");

    expect(navigation.isSettingsSectionEnabled("usage")).toBe(true);
    expect(navigation.resolveSettingsSection("usage", "modelProvider")).toBe(
      "usage",
    );
    expect(navigation.isSettingsSectionEnabled("hooks")).toBe(true);
    expect(navigation.resolveSettingsSection("hooks", "modelProvider")).toBe(
      "hooks",
    );
    expect(navigation.isSettingsSectionEnabled("memory")).toBe(true);
    expect(navigation.resolveSettingsSection("memory", "general")).toBe(
      "memory",
    );
  });

  it("在 production 环境也保留 usage 分区", async () => {
    const navigation = await loadSettingsNavigation("production");

    expect(navigation.isSettingsSectionEnabled("usage")).toBe(true);
    expect(navigation.resolveSettingsSection("usage", "modelProvider")).toBe(
      "usage",
    );
    expect(navigation.isSettingsSectionEnabled("hooks")).toBe(true);
    expect(navigation.resolveSettingsSection("hooks", "modelProvider")).toBe(
      "hooks",
    );
  });

  it("通知已打开的设置页切换到新的分区意图", async () => {
    const eventTarget = new EventTarget();
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
    });
    const navigation = await loadSettingsNavigation("test");
    const listener = vi.fn();

    const dispose = navigation.addPendingSettingsSectionListener(listener);
    navigation.setPendingSettingsSection("general");

    expect(listener).toHaveBeenCalledWith("general", {
      section: "general",
      usageTab: undefined,
      modelProviderId: undefined,
    });
    expect(storage.has("zcode-settings-section-intent")).toBe(false);
    dispose();
  });

  it("Quick Pick 的 MCP、Skill 与 Command 意图直达独立分区", async () => {
    const eventTarget = new EventTarget();
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    const navigation = await loadSettingsNavigation("test");
    const listener = vi.fn();
    const dispose = navigation.addPendingSettingsSectionListener(listener);

    navigation.setPendingSettingsPluginIntent("mcps");
    expect(listener).toHaveBeenLastCalledWith(
      "mcp",
      expect.objectContaining({
        section: "mcp",
      }),
    );

    navigation.setPendingSettingsPluginIntent("skills");
    expect(listener).toHaveBeenLastCalledWith(
      "skill",
      expect.objectContaining({ section: "skill" }),
    );
    navigation.setPendingSettingsPluginIntent("commands");
    expect(listener).toHaveBeenLastCalledWith(
      "commands",
      expect.objectContaining({ section: "commands" }),
    );
    dispose();
  });

  it("插件市场管理入口携带一次性的父级来源", async () => {
    const eventTarget = new EventTarget();
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    const navigation = await loadSettingsNavigation("plugin-store-origin");

    const workspaceScopeKey = "remote:ssh:host-a:22:user:/workspace";
    navigation.setPendingSettingsPluginIntent("plugins", {
      origin: "plugin-store",
      scopeKey: workspaceScopeKey,
    });

    expect(navigation.consumePendingSettingsPluginOrigin()).toBe("plugin-store");
    expect(navigation.consumePendingSettingsPluginScopeKey()).toBe(workspaceScopeKey);
    expect(navigation.consumePendingSettingsPluginScopeKey()).toBe(workspaceScopeKey);
    navigation.clearPendingSettingsPluginScopeKey();
    expect(navigation.consumePendingSettingsPluginScopeKey()).toBeUndefined();
    expect(navigation.consumePendingSettingsPluginOrigin()).toBe("plugin-store");
    navigation.clearPendingSettingsPluginOrigin();
    expect(navigation.consumePendingSettingsPluginOrigin()).toBeUndefined();
  });

  it("已打开的设置页收到具体 Workspace scopeKey，事件消费后不会残留到下次挂载", async () => {
    const eventTarget = new EventTarget();
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    const navigation = await loadSettingsNavigation("test");
    const listener = vi.fn();
    const dispose = navigation.addPendingSettingsSectionListener(listener);
    const scopeKey = "remote:ssh:host-b:22:user:/workspace";

    navigation.setPendingSettingsPluginIntent("plugins", {
      origin: "plugin-store",
      scopeKey,
    });

    expect(listener).toHaveBeenCalledWith(
      "plugin",
      expect.objectContaining({
        pluginOrigin: "plugin-store",
        pluginScopeKey: scopeKey,
        pluginTab: "plugins",
      }),
    );
    expect(storage.has("zcode-settings-plugin-scope-key-intent")).toBe(false);
    expect(navigation.consumePendingSettingsPluginScopeKey()).toBeUndefined();
    dispose();
  });

  it("剩余额度详情入口写入 usage coding plan 跳转意图", async () => {
    const eventTarget = new EventTarget();
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
      localStorage: {
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => undefined,
      },
    });
    const navigation = await loadSettingsNavigation("test");
    const listener = vi.fn();
    const dispose = navigation.addPendingSettingsSectionListener(listener);

    navigation.setPendingSettingsUsageCodingPlanIntent();

    expect(listener).toHaveBeenCalledWith("usage", {
      section: "usage",
      usageTab: "codingPlan",
      modelProviderId: undefined,
    });
    expect(navigation.consumePendingSettingsUsageTab()).toBeUndefined();

    dispose();
    navigation.setPendingSettingsUsageCodingPlanIntent();

    expect(navigation.consumeInitialSettingsSection("general")).toBe("usage");
    expect(navigation.consumePendingSettingsUsageTab()).toBe("codingPlan");
  });

  it("provider loading 期间保留 coding plan 使用统计 tab 意图", async () => {
    const navigation = await loadSettingsNavigation("test");

    expect(
      navigation.shouldFallbackSettingsUsageTabToApp({
        activeTab: "codingPlan",
        checkingCodingPlanTab: false,
        loadingModelProviders: true,
        showCodingPlanTab: false,
      }),
    ).toBe(false);
    expect(
      navigation.shouldFallbackSettingsUsageTabToApp({
        activeTab: "codingPlan",
        checkingCodingPlanTab: true,
        loadingModelProviders: false,
        showCodingPlanTab: false,
      }),
    ).toBe(false);
    expect(
      navigation.shouldFallbackSettingsUsageTabToApp({
        activeTab: "codingPlan",
        checkingCodingPlanTab: false,
        loadingModelProviders: false,
        showCodingPlanTab: false,
      }),
    ).toBe(true);
  });

  it("旧版已删除分区意图会回落到安全分区", async () => {
    const storage = new Map<string, string>([
      ["zcode-settings-section-intent", "legacy-removed-section"],
    ]);
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
    });
    const navigation = await loadSettingsNavigation("test");

    expect(navigation.consumePendingSettingsSection("modelProvider")).toBe(
      "modelProvider",
    );
    expect(storage.has("zcode-settings-section-intent")).toBe(false);
  });

  it("保留 MCP 设置分区为独立入口", async () => {
    const sessionStorage = new Map<string, string>();
    const localStorage = new Map<string, string>([
      ["zcode-settings-last-section", "mcp"],
    ]);
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => sessionStorage.get(key) ?? null,
        removeItem: (key: string) => sessionStorage.delete(key),
        setItem: (key: string, value: string) => {
          sessionStorage.set(key, value);
        },
      },
      localStorage: {
        getItem: (key: string) => localStorage.get(key) ?? null,
        removeItem: (key: string) => localStorage.delete(key),
        setItem: (key: string, value: string) => {
          localStorage.set(key, value);
        },
      },
    });
    const navigation = await loadSettingsNavigation("test");

    expect(navigation.consumeInitialSettingsSection("general")).toBe("mcp");
    expect(localStorage.get("zcode-settings-last-section")).toBe("mcp");
  });

  it("把旧 Skills 一次性跳转意图迁移到独立 skill 入口", async () => {
    const sessionStorage = new Map<string, string>([
      ["zcode-settings-section-intent", "skills"],
    ]);
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => sessionStorage.get(key) ?? null,
        removeItem: (key: string) => sessionStorage.delete(key),
        setItem: (key: string, value: string) => sessionStorage.set(key, value),
      },
      localStorage: {
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => undefined,
      },
    });
    const navigation = await loadSettingsNavigation("test");

    expect(navigation.consumeInitialSettingsSection("general")).toBe("skill");
  });

  it("清理不再保留的 customize 分区", async () => {
    const localStorage = new Map<string, string>([
      ["zcode-settings-last-section", "customize"],
    ]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => localStorage.get(key) ?? null,
        removeItem: (key: string) => localStorage.delete(key),
        setItem: (key: string, value: string) => localStorage.set(key, value),
      },
      sessionStorage: {
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => undefined,
      },
    });
    const navigation = await loadSettingsNavigation("test");

    expect(navigation.readLastSettingsSectionPreference("general")).toBe(
      "general",
    );
    expect(localStorage.has("zcode-settings-last-section")).toBe(false);
  });

  it("把旧代码预览分区迁移到外观", async () => {
    const localStorage = new Map<string, string>([
      ["zcode-settings-last-section", "codePreview"],
    ]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => localStorage.get(key) ?? null,
        removeItem: (key: string) => localStorage.delete(key),
        setItem: (key: string, value: string) => localStorage.set(key, value),
      },
    });
    const navigation = await loadSettingsNavigation("test");

    expect(navigation.readLastSettingsSectionPreference()).toBe("appearance");
    expect(localStorage.get("zcode-settings-last-section")).toBe("appearance");
  });

  it("显式设置分区意图优先于上次停留分区", async () => {
    const sessionStorage = new Map<string, string>([
      ["zcode-settings-section-intent", "modelProvider"],
    ]);
    const localStorage = new Map<string, string>([
      ["zcode-settings-last-section", "mcp"],
    ]);
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => sessionStorage.get(key) ?? null,
        removeItem: (key: string) => sessionStorage.delete(key),
        setItem: (key: string, value: string) => {
          sessionStorage.set(key, value);
        },
      },
      localStorage: {
        getItem: (key: string) => localStorage.get(key) ?? null,
        removeItem: (key: string) => localStorage.delete(key),
        setItem: (key: string, value: string) => {
          localStorage.set(key, value);
        },
      },
    });
    const navigation = await loadSettingsNavigation("test");

    expect(navigation.consumeInitialSettingsSection("general")).toBe(
      "modelProvider",
    );
    expect(sessionStorage.has("zcode-settings-section-intent")).toBe(false);
  });

  it("记录设置页最后停留分区并清理非法旧值", async () => {
    const localStorage = new Map<string, string>([
      ["zcode-settings-last-section", "legacy-removed-section"],
    ]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => localStorage.get(key) ?? null,
        removeItem: (key: string) => localStorage.delete(key),
        setItem: (key: string, value: string) => {
          localStorage.set(key, value);
        },
      },
      sessionStorage: {
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => undefined,
      },
    });
    const navigation = await loadSettingsNavigation("test");

    expect(navigation.readLastSettingsSectionPreference("general")).toBe(
      "general",
    );
    expect(localStorage.has("zcode-settings-last-section")).toBe(false);

    navigation.writeLastSettingsSectionPreference("plugin");

    expect(localStorage.get("zcode-settings-last-section")).toBe("plugin");
  });

  it("保留 hooks 分区的历史偏好", async () => {
    const localStorage = new Map<string, string>([
      ["zcode-settings-last-section", "hooks"],
    ]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => localStorage.get(key) ?? null,
        removeItem: (key: string) => localStorage.delete(key),
        setItem: (key: string, value: string) => {
          localStorage.set(key, value);
        },
      },
      sessionStorage: {
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => undefined,
      },
    });
    const navigation = await loadSettingsNavigation("test");

    expect(navigation.readLastSettingsSectionPreference("general")).toBe(
      "hooks",
    );

    navigation.writeLastSettingsSectionPreference("hooks");

    expect(localStorage.get("zcode-settings-last-section")).toBe("hooks");
  });
});
