import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  },
  systemService: {
    info: remoteSystemInfo,
    listIntegratedTerminalShells: remoteListIntegratedTerminalShells,
  },
};

const localServices = {
  settingService: remoteServices.settingService,
  systemService: {
    info: localSystemInfo,
    listIntegratedTerminalShells: localListIntegratedTerminalShells,
  },
};

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
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
  canOpenCommunity: vi.fn(async () => false),
  getZCodeStdioTapDevState: vi.fn(async () => ({
    enabled: false,
    visible: false,
  })),
  getWindowControlsOverlayMetrics: vi.fn(() => ({ rightPaddingPx: 188 })),
  onWindowControlsOverlayChanged: vi.fn(
    (handler: (metrics: { rightPaddingPx?: number }) => void) => {
      handler({ rightPaddingPx: 188 });
      return () => {};
    },
  ),
};

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => mockPlatform,
  useSelectDirectory: () => vi.fn(async () => null),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => remoteServices,
  useServices: () => remoteServices,
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => localServices,
  useWorkspaceServicesResolution: () => ({
    services: remoteServices,
    remoteSessionId: null,
    isRemoteTarget: false,
    connectionKind: "local-ready",
    rpcReady: true,
  }),
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({ settings: undefined, update: vi.fn() }),
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
  useTabStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activeWorkspaceIdentity: undefined,
      activeWorkspacePath: undefined,
      tabs: [],
    }),
}));

vi.mock("@/lib/settingsNavigation.js", () => ({
  addPendingSettingsSectionListener: () => () => {},
  consumeInitialSettingsSection: () => "general",
  consumePendingSettingsPluginTab: () => undefined,
  consumePendingSettingsPluginOrigin: () => undefined,
  consumePendingSettingsPluginScopeKey: () => undefined,
  clearPendingSettingsPluginOrigin: () => undefined,
  clearPendingSettingsPluginScopeKey: () => undefined,
  consumePendingSettingsModelProviderTarget: () => undefined,
  consumePendingSettingsUsageTab: () => undefined,
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
  BrowserSettingsSection: () => null,
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
        id: "general",
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
  GeneralSectionContent: (props: Record<string, unknown>) => {
    generalSectionCapture.props = props;
    return createElement("div", null, "general");
  },
  GeneralSectionHeader: () => null,
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
    generalSectionCapture.props = undefined;
    settingsPageConfigCalls.length = 0;
    vi.clearAllMocks();
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

  it("uses a fixed inline action-group inset instead of native caption metrics", async () => {
    const { SettingsPage } = await import("../src/SettingsPage.js");

    renderToStaticMarkup(
      createElement(SettingsPage, {
        isWindowsDesktop: true,
      }),
    );
    const html = renderToStaticMarkup(
      createElement(SettingsPage, { isDesktop: true, isWindowsDesktop: true }),
    );
    expect(html).toContain("mr-[134px]");
    expect(mockPlatform.getWindowControlsOverlayMetrics).not.toHaveBeenCalled();
    expect(mockPlatform.onWindowControlsOverlayChanged).not.toHaveBeenCalled();
  });

  it.each([
    ["macOS", { isDesktop: true, isMacDesktop: true, isWindowsDesktop: false }],
    ["Windows", { isDesktop: true, isMacDesktop: false, isWindowsDesktop: true }],
    ["Linux", { isDesktop: true, isMacDesktop: false, isWindowsDesktop: false }],
  ])(
    "keeps the %s settings content frame 4px from the desktop window edge",
    async (_platform, props) => {
      const { SettingsPage } = await import("../src/SettingsPage.js");
      const html = renderToStaticMarkup(createElement(SettingsPage, props));

      expect(html).toContain("grid-cols-[68px_minmax(0,1fr)]");
      expect(html).toContain("lg:grid-cols-[268px_minmax(0,1fr)]");
      expect(html).toMatch(/data-settings-content-frame="true"[^>]*p-1 pl-0 pt-0/);
      expect(html).toContain('data-settings-top-inset="true"');
    },
  );

  it("uses 5px for the Windows settings panel and preserves other platform radii", async () => {
    const { SettingsPage } = await import("../src/SettingsPage.js");
    const windowsHtml = renderToStaticMarkup(
      createElement(SettingsPage, { isDesktop: true, isWindowsDesktop: true }),
    );
    const macHtml = renderToStaticMarkup(
      createElement(SettingsPage, { isDesktop: true, isMacDesktop: true }),
    );
    const linuxHtml = renderToStaticMarkup(createElement(SettingsPage, { isDesktop: true }));

    expect(windowsHtml).toMatch(/data-settings-panel-frame="true"[^>]*rounded-\[5px\]/);
    expect(macHtml).toMatch(/data-settings-panel-frame="true"[^>]*rounded-xl/);
    expect(linuxHtml).toMatch(/data-settings-panel-frame="true"[^>]*rounded-xl/);
  });

  it("does not add the desktop frame inset to web settings", async () => {
    const { SettingsPage } = await import("../src/SettingsPage.js");
    const html = renderToStaticMarkup(createElement(SettingsPage, { isDesktop: false }));

    expect(html).toMatch(/data-settings-content-frame="true"[^>]*p-0/);
    expect(html).not.toContain('data-settings-top-inset="true"');
  });

  it("keeps Linux settings titlebar controls on the themed page background", async () => {
    const { SettingsPage } = await import("../src/SettingsPage.js");

    const html = renderToStaticMarkup(
      createElement(SettingsPage, {
        isDesktop: true,
        isMacDesktop: false,
        isWindowsDesktop: false,
      }),
    );

    expect(html).toContain('data-testid="desktop-window-controls"');
    expect(html).toContain("lucide-circle-question-mark");
    expect(html).not.toContain("lucide-chevron-down");
    expect(html).not.toContain("w-[120px]");
    expect(html).toContain("mr-[134px]");
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
});
