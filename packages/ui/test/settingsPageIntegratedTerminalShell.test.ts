import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const selectedSection = vi.hoisted(() => ({ value: "general" }));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

const stateUpdates = vi.hoisted(() => [] as unknown[]);
const pendingEffects = vi.hoisted(() => [] as Array<() => void | (() => void)>);
const generalSectionCapture = vi.hoisted(
  () => ({ props: undefined }) as { props: Record<string, unknown> | undefined },
);
const settingsPageConfigCalls = vi.hoisted(
  () =>
    [] as Array<{
      isDesktop?: boolean;
      isMacDesktop?: boolean;
      isWindowsDesktop?: boolean;
    }>,
);
const sharedSettingsState = vi.hoisted(
  () =>
    ({ value: undefined }) as {
      value: Record<string, unknown> | undefined;
    },
);
const sourceServerManagementState = vi.hoisted(
  () =>
    ({ value: undefined }) as {
      value: Record<string, unknown> | undefined;
    },
);

const remoteSystemInfo = vi.fn(async () => ({
  homedir: "C:\\Users\\remote",
  platform: "win32" as const,
}));
const remoteListIntegratedTerminalShells = vi.fn(async () => [
  {
    dialect: "git-bash" as const,
    id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
    label: "Git Bash",
    path: "C:\\Program Files\\Git\\bin\\bash.exe",
    source: "system" as const,
  },
]);
const localSystemInfo = vi.fn(async () => ({
  homedir: "/Users/local",
  platform: "darwin" as const,
}));
const localListIntegratedTerminalShells = vi.fn(async () => []);

const remoteServices = {
  codingPlanSubscriptionService: {
    getEnterprisePricing: vi.fn(async () => ({ productList: [] })),
  },
  settingService: {
    get: vi.fn(async () => ({})),
    update: vi.fn(async () => {}),
    updateDataBaseDir: vi.fn(async () => {}),
  },
  systemService: {
    info: remoteSystemInfo,
    listIntegratedTerminalShells: remoteListIntegratedTerminalShells,
  },
};

const localServices = {
  // 回归：不能让本机与 Source 共用一个替身，否则写错机器也会通过。
  settingService: {
    get: vi.fn(async () => ({})),
    update: vi.fn(async () => {}),
    updateDataBaseDir: vi.fn(async () => {}),
  },
  systemService: {
    info: localSystemInfo,
    listIntegratedTerminalShells: localListIntegratedTerminalShells,
  },
};

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useState: (initial: unknown) => {
      const [value, setValue] = actual.useState(initial);
      return [
        value,
        (next: unknown) => {
          stateUpdates.push(next);
          setValue(next);
        },
      ];
    },
    useEffect: (effect: () => void | (() => void)) => {
      pendingEffects.push(effect);
    },
  };
});

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("button", props, children),
}));

vi.mock("@/components/ui/tabs.js", () => ({
  Tabs: ({ children }: { children: unknown }) => createElement("div", null, children),
  TabsList: ({ children }: { children: unknown }) => createElement("div", null, children),
  TabsTrigger: ({ children }: { children: unknown }) => createElement("button", null, children),
}));

vi.mock("@/DesktopWindowFrame.js", () => ({
  DesktopWindowFrame: ({ children }: { children: unknown }) => createElement("div", null, children),
}));

vi.mock("@/WorkspaceSidebarFooter.js", () => ({
  WorkspaceSidebarFooter: () => null,
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: unknown }) => children,
}));

vi.mock("@/components/lib/utils.js", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    localePreference: "system",
    setLocalePreference: vi.fn(),
  }),
}));

const mockPlatform = {
  syncAppSettings: vi.fn(),
  canOpenCommunity: vi.fn(async () => false),
  getZCodeStdioTapDevState: vi.fn(async () => ({
    enabled: false,
    visible: false,
  })),
};

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => mockPlatform,
  useSelectDirectory: () => vi.fn(async () => null),
}));

vi.mock("@/hooks/useServices.js", () => ({
  ServiceProvider: ({ children }: { children: unknown }) => createElement("div", null, children),
  useOptionalServices: () => remoteServices,
  useServices: () => remoteServices,
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () =>
    sourceServerManagementState.value
      ? {
          ...localServices,
          sourceServerManagementService: sourceServerManagementState.value,
        }
      : localServices,
  useWorkspaceServicesResolution: () => ({
    services: remoteServices,
    remoteSessionId: null,
    isRemoteTarget: false,
    connectionKind: "local-ready",
    rpcReady: true,
  }),
}));

const updateSharedSettings = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: sharedSettingsState.value, update: updateSharedSettings }),
}));

vi.mock("@/hooks/useModelProviders.js", () => ({
  useModelProviders: () => ({ loading: false, modelProviders: [] }),
}));

vi.mock("@/hooks/useUsageEntitlement.js", () => ({
  useUsageEntitlement: () => ({
    loading: false,
    snapshot: undefined,
    error: undefined,
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (_selector: unknown, fallback: unknown) => fallback,
  useZCodeStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      codePreviewSettings: {},
      notificationEnabled: true,
      notificationSoundEnabled: true,
      requestOnboardingDialog: vi.fn(),
      setCodePreviewSettings: vi.fn(),
      setNotificationEnabled: vi.fn(),
      setNotificationSoundEnabled: vi.fn(),
      setTheme: vi.fn(),
      theme: "system",
    }),
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useOptionalTabStore: () => undefined,
  useTabStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activeWorkspaceIdentity: undefined,
      activeWorkspacePath: undefined,
      tabs: [],
    }),
}));

vi.mock("@/lib/settingsNavigation.js", () => ({
  addPendingSettingsSectionListener: () => () => {},
  consumeInitialSettingsSection: () => selectedSection.value,
  consumePendingSettingsPluginTab: () => undefined,
  consumePendingSettingsPluginOrigin: () => undefined,
  consumePendingSettingsPluginScopeKey: () => undefined,
  clearPendingSettingsPluginOrigin: () => undefined,
  clearPendingSettingsPluginScopeKey: () => undefined,
  consumePendingSettingsModelProviderTarget: () => undefined,
  consumePendingSettingsUsageTab: () => undefined,
  consumePendingSettingsSourceServerId: () => undefined,
  consumePendingSettingsSourceServerDetails: () => false,
  resolveSettingsSection: (section: string) => section,
  shouldFallbackSettingsUsageTabToApp: () => false,
  writeLastSettingsSectionPreference: vi.fn(),
}));

vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  useCodingPlanUpgradeDialog: () => ({
    openCodingPlanUpgrade: vi.fn(),
  }),
}));

vi.mock("@/lib/sidebarUsageCodingPlanProviderPreference.js", () => ({
  readSidebarUsageCodingPlanProviderPreference: () => undefined,
  readSidebarUsageCodingPlanSourcePreference: () => undefined,
  writeSidebarUsageCodingPlanProviderPreference: vi.fn(),
}));

vi.mock("@/lib/codingPlanProvider.js", () => ({}));

vi.mock("@/settings/ModelProviderSection.js", () => ({
  ModelProviderSection: () => null,
}));
vi.mock("@/settings/McpSettingsSection.js", () => ({
  McpSettingsSection: () => null,
}));
vi.mock("@/settings/UsageStatsSection.js", () => ({
  UsageStatsSection: () => null,
}));
vi.mock("@/settings/SkillsSection.js", () => ({
  SkillsSection: () => null,
}));
vi.mock("@/project-sidebar/ArchiveManagement.js", () => ({ ArchiveManagement: () => null }));
vi.mock("@/settings/PluginsSection.js", () => ({
  PluginsSection: () => null,
}));
vi.mock("@/settings/CommandsSection.js", () => ({
  CommandsSection: () => null,
}));
vi.mock("@/settings/HooksSection.js", () => ({
  HooksSection: () => null,
}));
vi.mock("@/settings/BrowserSettingsSection.js", () => ({
  BrowserSettingsSection: (props: Record<string, unknown>) => {
    generalSectionCapture.props = props;
    return createElement("div");
  },
}));
vi.mock("@/settings/MigrationSection.js", () => ({
  MigrationSection: () => null,
}));
vi.mock("../src/settingsCodePreview.js", () => ({
  AppearanceSectionContent: () => null,
}));

vi.mock("../src/settingsPageHelpers.js", () => ({
  createSettingsPageConfig: (options: {
    isDesktop?: boolean;
    isMacDesktop?: boolean;
    isWindowsDesktop?: boolean;
  }) => {
    settingsPageConfigCalls.push(options);
    const settingsSections = [
      {
        id: selectedSection.value,
        titleId: "settings.general",
        navLabelId: "settings.general",
        icon: () => null,
      },
    ];
    return {
      settingsSectionGroups: [
        {
          id: "basics",
          titleId: "settings.general",
          sections: settingsSections,
        },
      ],
      settingsSections,
    };
  },
  resolveSettingsSectionForPlatform: (section: string) => section,
  isSettingsSectionAvailable: () => true,
  GeneralSectionContent: (props: Record<string, unknown>) => {
    generalSectionCapture.props = props;
    return createElement("div", null, "general");
  },
  GeneralSectionHeader: () => null,
  TaskAutoArchiveSettings: (props: Record<string, unknown>) => {
    generalSectionCapture.props = props;
    return null;
  },
}));

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function flushPendingEffects() {
  const effects = pendingEffects.splice(0);
  for (const effect of effects) {
    effect();
  }
}

describe("SettingsPage integrated terminal shell", () => {
  beforeEach(() => {
    pendingEffects.length = 0;
    selectedSection.value = "general";
    stateUpdates.length = 0;
    localServices.settingService.get.mockReset().mockResolvedValue({});
    remoteServices.settingService.get.mockReset().mockResolvedValue({});
    generalSectionCapture.props = undefined;
    settingsPageConfigCalls.length = 0;
    sharedSettingsState.value = undefined;
    sourceServerManagementState.value = undefined;
    vi.clearAllMocks();
    localServices.settingService.update.mockReset().mockResolvedValue(undefined);
    remoteSystemInfo.mockResolvedValue({
      homedir: "C:\\Users\\remote",
      platform: "win32",
    });
    remoteListIntegratedTerminalShells.mockResolvedValue([
      {
        dialect: "git-bash",
        id: "git-bash:C:\\Program Files\\Git\\bin\\bash.exe",
        label: "Git Bash",
        path: "C:\\Program Files\\Git\\bin\\bash.exe",
        source: "system",
      },
    ]);
    localSystemInfo.mockResolvedValue({
      homedir: "/Users/local",
      platform: "darwin",
    });
    localListIntegratedTerminalShells.mockResolvedValue([]);
  });

  // Bugfix: 本用例是该文件第一个 import SettingsPage 的测试，独吞整棵设置页模块图的
  // 冷启动（vitest 按文件隔离 worker，模块缓存不跨文件共享）；全量高负载下冷导入会
  // 顶穿全局 testTimeout 30s。只放宽这一条冷启动用例，后续用例命中缓存不受影响。
  it("renders the settings navigation as labelled groups", async () => {
    const { SettingsPage } = await import("../src/SettingsPage.js");

    const html = renderToStaticMarkup(createElement(SettingsPage, { isWindowsDesktop: true }));

    expect(settingsPageConfigCalls).toEqual([
      {
        isDesktop: false,
        isMacDesktop: false,
        isWindowsDesktop: true,
      },
    ]);
    expect(html).toContain('aria-label="settings.navLabel"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-labelledby="settings-sidebar-group-basics"');
    expect(html).toContain('id="settings-sidebar-group-basics"');
  }, 90_000);

  it("defaults ToolSearch off and saves the selected mode through shared settings", async () => {
    const { SettingsPage } = await import("../src/SettingsPage.js");
    renderToStaticMarkup(createElement(SettingsPage, {}));
    expect(generalSectionCapture.props?.toolSearchMode).toBe("off");
    const change = generalSectionCapture.props?.onToolSearchModeChange as (
      mode: "auto" | "local" | "off",
    ) => Promise<void>;
    for (const mode of ["auto", "local", "off"] as const) {
      await change(mode);
      expect(updateSharedSettings).toHaveBeenLastCalledWith({ toolSearchMode: mode });
    }
  });

  it("defaults message stream reasoning to visible before settings hydrate", async () => {
    const { SettingsPage } = await import("../src/SettingsPage.js");

    renderToStaticMarkup(createElement(SettingsPage, {}));

    expect(generalSectionCapture.props?.messageStreamShowReasoning).toBe(true);
  });

  it("uses the local host system service for the global shell setting", async () => {
    const { SettingsPage } = await import("../src/SettingsPage.js");

    renderToStaticMarkup(createElement(SettingsPage, {}));
    flushPendingEffects();
    await flushPromises();

    expect(localSystemInfo).toHaveBeenCalled();
    expect(remoteSystemInfo).not.toHaveBeenCalled();
    expect(localListIntegratedTerminalShells).not.toHaveBeenCalled();
    expect(remoteListIntegratedTerminalShells).not.toHaveBeenCalled();
  });

  it("shows inline window controls on Linux desktop", async () => {
    const { SettingsPage } = await import("../src/SettingsPage.js");

    const html = renderToStaticMarkup(
      createElement(SettingsPage, {
        isDesktop: true,
        isMacDesktop: false,
        isWindowsDesktop: false,
      }),
    );

    expect(html).toContain('data-testid="desktop-window-controls"');
  });

  it("lists shell options from the local host even when the remote workspace is non-Windows", async () => {
    remoteSystemInfo.mockResolvedValue({
      homedir: "/home/remote",
      platform: "linux",
    });
    localSystemInfo.mockResolvedValue({
      homedir: "C:\\Users\\local",
      platform: "win32",
    });

    const { SettingsPage } = await import("../src/SettingsPage.js");

    renderToStaticMarkup(createElement(SettingsPage, {}));
    flushPendingEffects();
    await flushPromises();

    expect(localSystemInfo).toHaveBeenCalled();
    expect(localListIntegratedTerminalShells).toHaveBeenCalled();
    expect(remoteSystemInfo).not.toHaveBeenCalled();
    expect(remoteListIntegratedTerminalShells).not.toHaveBeenCalled();
  });

  it.each([
    [
      "onDesktopChromiumHardwareAccelerationChange",
      false,
      { desktopChromiumHardwareAccelerationEnabled: false },
    ],
    ["onCloseToTrayOnWindowsChange", false, { closeToTrayOnWindows: false }],
    [
      "onIntegratedTerminalShellChange",
      {
        mode: "shell",
        id: "powershell",
        dialect: "powershell",
        label: "PowerShell",
        path: "C:\\PowerShell\\pwsh.exe",
      },
      {
        integratedTerminalShell: {
          mode: "shell",
          id: "powershell",
          dialect: "powershell",
          label: "PowerShell",
          path: "C:\\PowerShell\\pwsh.exe",
        },
      },
    ],
    ["onHttpProxyChange", " http://127.0.0.1:7890 ", { httpProxy: "http://127.0.0.1:7890" }],
    [
      "onHttpProxyNoProxyChange",
      " localhost, , .example.test ",
      { httpProxyNoProxy: "localhost,.example.test" },
    ],
    [
      "onHttpProxyCaCertPathChange",
      " /local/root-ca.pem ",
      { httpProxyCaCertPath: "/local/root-ca.pem" },
    ],
  ])(
    "persists Desktop %s on the base Host while Source is active",
    async (callback, value, patch) => {
      const { SettingsPage } = await import("../src/SettingsPage.js");
      renderToStaticMarkup(createElement(SettingsPage, { isDesktop: true }));
      await (generalSectionCapture.props![callback] as (value: unknown) => Promise<void>)(value);
      expect(localServices.settingService.update).toHaveBeenCalledWith(patch);
      expect(remoteServices.settingService.update).not.toHaveBeenCalled();
    },
  );

  it("keeps native directory migration on the Desktop", async () => {
    const { SettingsPage } = await import("../src/SettingsPage.js");
    renderToStaticMarkup(createElement(SettingsPage, { isDesktop: true }));
    await (generalSectionCapture.props!.onDataBaseDirChange as (dir: string) => Promise<void>)(
      "/local/selected-folder",
    );
    expect(localServices.settingService.updateDataBaseDir).toHaveBeenCalledWith(
      "/local/selected-folder",
    );
    expect(remoteServices.settingService.updateDataBaseDir).not.toHaveBeenCalled();
  });

  it("propagates local save failures without updating the tray or falling back to Source", async () => {
    localServices.settingService.update.mockRejectedValueOnce(new Error("local disk failure"));
    const { SettingsPage } = await import("../src/SettingsPage.js");
    renderToStaticMarkup(createElement(SettingsPage, { isDesktop: true }));
    await expect(
      (
        generalSectionCapture.props!.onCloseToTrayOnWindowsChange as (
          enabled: boolean,
        ) => Promise<void>
      )(false),
    ).rejects.toThrow("local disk failure");
    expect(mockPlatform.syncAppSettings).not.toHaveBeenCalled();
    expect(remoteServices.settingService.update).not.toHaveBeenCalled();
  });

  it.each([
    ["onTerminalInheritSystemProfileChange", false, { terminalInheritSystemProfile: false }],
    ["onTerminalFontFamilyChange", " Source Mono ", { terminalFontFamily: "Source Mono" }],
    ["onTaskAutoArchiveEnabledChange", true, { taskAutoArchiveEnabled: true }],
    ["onTaskAutoArchiveOlderThanDaysChange", 30, { taskAutoArchiveOlderThanDays: 30 }],
  ])("preserves target Environment ownership for %s", async (callback, value, patch) => {
    const { SettingsPage } = await import("../src/SettingsPage.js");
    if (String(callback).startsWith("onTaskAutoArchive")) selectedSection.value = "archives";
    renderToStaticMarkup(createElement(SettingsPage, { isDesktop: true }));
    await (generalSectionCapture.props![callback] as (value: unknown) => Promise<void>)(value);
    expect(remoteServices.settingService.update).toHaveBeenCalledWith(patch);
    expect(localServices.settingService.update).not.toHaveBeenCalled();
  });

  it("persists embedded browser certificate policy on Desktop", async () => {
    selectedSection.value = "browser";
    const { SettingsPage } = await import("../src/SettingsPage.js");
    renderToStaticMarkup(createElement(SettingsPage, { isDesktop: true }));
    await (
      generalSectionCapture.props!.onEmbeddedBrowserAllowInsecureCertificatesChange as (
        enabled: boolean,
      ) => Promise<void>
    )(true);
    expect(localServices.settingService.update).toHaveBeenCalledWith({
      embeddedBrowserAllowInsecureCertificates: true,
    });
    expect(remoteServices.settingService.update).not.toHaveBeenCalled();
  });

  it("propagates local migration failure without invoking Source migration", async () => {
    localServices.settingService.updateDataBaseDir.mockRejectedValueOnce(new Error("copy denied"));
    const { SettingsPage } = await import("../src/SettingsPage.js");
    renderToStaticMarkup(createElement(SettingsPage, { isDesktop: true }));
    await expect(
      (generalSectionCapture.props!.onDataBaseDirChange as (dir: string) => Promise<void>)(
        "/local/denied",
      ),
    ).rejects.toThrow("copy denied");
    expect(remoteServices.settingService.updateDataBaseDir).not.toHaveBeenCalled();
  });
  it("hydrates each field from its owning Environment despite conflicting snapshots", async () => {
    localServices.settingService.get.mockResolvedValueOnce({
      dataBaseDir: "/desktop/data",
      httpProxy: "http://desktop-proxy:7890",
      terminalFontFamily: "wrong local font",
      taskAutoArchiveOlderThanDays: 91,
    });
    remoteServices.settingService.get.mockResolvedValueOnce({
      dataBaseDir: "/source/data",
      httpProxy: "http://source-proxy:7890",
      terminalFontFamily: "Source Mono",
      taskAutoArchiveOlderThanDays: 30,
    });
    const { SettingsPage } = await import("../src/SettingsPage.js");
    renderToStaticMarkup(createElement(SettingsPage, { isDesktop: true }));
    flushPendingEffects();
    await flushPromises();
    expect(stateUpdates).toEqual(
      expect.arrayContaining(["/desktop/data", "http://desktop-proxy:7890", "Source Mono", 30]),
    );
    for (const wrong of ["/source/data", "http://source-proxy:7890", "wrong local font", 91])
      expect(stateUpdates).not.toContain(wrong);
  });

  it("ignores pending settings reads after the owning page is detached", async () => {
    let completeLocal!: (value: Record<string, unknown>) => void;
    let completeSource!: (value: Record<string, unknown>) => void;
    localServices.settingService.get.mockReturnValueOnce(
      new Promise((resolve) => {
        completeLocal = resolve;
      }),
    );
    remoteServices.settingService.get.mockReturnValueOnce(
      new Promise((resolve) => {
        completeSource = resolve;
      }),
    );
    const { SettingsPage } = await import("../src/SettingsPage.js");
    renderToStaticMarkup(createElement(SettingsPage, { isDesktop: true }));
    const cleanups = pendingEffects.splice(0).map((effect) => effect());
    for (const cleanup of cleanups) cleanup?.();
    completeLocal({ dataBaseDir: "/stale/desktop" });
    completeSource({ terminalFontFamily: "stale Source font" });
    await flushPromises();
    expect(stateUpdates).not.toContain("/stale/desktop");
    expect(stateUpdates).not.toContain("stale Source font");
  });
});
