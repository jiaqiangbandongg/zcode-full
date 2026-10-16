import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import {
  resolveSidebarFooterProfilePlanBadge,
  resolveSidebarFooterPlanBadgeLabel,
  WorkspaceSidebarFooterPlanBadge,
} from "@/WorkspaceSidebarFooterUsageSummary.js";
import { resolveSidebarCurrentCodingPlanUsageSource } from "@/lib/codingPlanUsageSources.js";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";

const mockFooterSettings = vi.hoisted(() => ({
  current: {
    modelProviderFamilySelectedKeys: {} as Record<string, string>,
    providerFamilyDomain: undefined as "zai" | "bigmodel" | undefined,
  },
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, title }: { children: unknown; title: string }) =>
    createElement("span", { "data-tooltip-title": title }, children),
}));

vi.mock("@/WorkspaceWebRemoteControlTrigger.js", () => ({
  WorkspaceWebRemoteControlTrigger: () =>
    createElement("button", {
      "data-testid": "web-remote-control-trigger",
    }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    executeDesktopCommand: vi.fn(),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    openExternal: vi.fn(),
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: { isRestoringOAuthSession: boolean }) => unknown) =>
    selector({ isRestoringOAuthSession: false }),
}));

vi.mock("@/hooks/useModelProviders.js", () => ({
  useModelProviders: () => ({
    modelProviders: [],
    loading: false,
  }),
}));

vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: mockFooterSettings.current,
    update: vi.fn(),
  }),
}));

vi.mock("@/hooks/useUsageEntitlement.js", () => ({
  useUsageEntitlement: () => ({
    snapshot: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock("@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js", () => ({
  useEnterpriseCodingPlanProducts: () => ({
    snapshot: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

describe("WorkspaceSidebarFooter web remote control tooltip", () => {
  beforeEach(() => {
    mockFooterSettings.current = {
      modelProviderFamilySelectedKeys: {},
      providerFamilyDomain: undefined,
    };
  });

  it("keeps long profile names constrained inside the footer row", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSidebarFooter, {
        theme: "dark",
        localeMenuValue: "zh-CN",
        onLocaleChange: () => {},
        onThemeChange: () => {},
        onSettingsButtonClick: () => {},
        user: {
          id: "user-long-name",
          username: "very-very-very-very-very-very-long-user-name",
          displayName: "VeryVeryVeryVeryVeryVeryVeryVeryLongDisplayName",
        },
      }),
    );

    expect(html).toContain("min-w-0 flex-1");
    expect(html).toContain("overflow-hidden");
    expect(html).toContain("text-left");
    expect(html).toContain("truncate text-ui-base font-semibold");
  });

  it("derives compact sidebar footer plan badge labels", () => {
    expect(
      resolveSidebarFooterPlanBadgeLabel({
        generatedAt: 1,
        authenticated: true,
        provider: null,
        remaining: null,
        subscription: null,
        quota: { level: "lite", limits: [] },
      }),
    ).toBe("Lite");
    expect(
      resolveSidebarFooterPlanBadgeLabel({
        generatedAt: 1,
        authenticated: true,
        provider: null,
        remaining: null,
        subscription: {
          identityType: "unknown",
          identityMasked: null,
          details: [
            {
              productId: "pro",
              productName: "GLM Coding Pro",
              purchaseTime: null,
              beginTime: null,
              expireTime: null,
            },
          ],
        },
        quota: null,
      }),
    ).toBe("Pro");
    expect(
      resolveSidebarFooterPlanBadgeLabel({
        generatedAt: 1,
        authenticated: true,
        unavailableReason: "no_plan",
        provider: null,
        remaining: null,
        subscription: null,
        quota: null,
      }),
    ).toBeNull();
  });

  it("shows Team in the profile badge for team usage sources", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSidebarFooterPlanBadge, {
        state: {
          profilePlanBadge: {
            audience: "team",
          },
          usageState: {
            visibleSnapshot: {
              generatedAt: 1,
              authenticated: true,
              provider: null,
              remaining: null,
              subscription: null,
              quota: { level: "max", limits: [] },
            },
          },
        },
      }),
    );

    expect(html).toContain("sidebar.usage.plan.audienceTeam");
    expect(html).toContain("text-ui-xs");
    expect(html).not.toContain("text-ui-sm");
    expect(html).not.toContain("Max");
  });

  it("prefers personal Coding Plan entitlement over Team entitlement", () => {
    const snapshot = {
      generatedAt: 1,
      authenticated: true,
      provider: {
        id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        name: "BigModel Coding Plan",
      },
      remaining: null,
      subscription: {
        identityType: "unknown" as const,
        identityMasked: null,
        details: [{ productId: "pro", productName: "GLM Coding Pro", expireTime: null }],
      },
      quota: null,
    };

    expect(
      resolveSidebarFooterProfilePlanBadge({
        hasTeamPlanEntitlement: true,
        individualEntitlements: [
          {
            providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            snapshot,
          },
        ],
      }),
    ).toEqual({
      audience: "individual",
      snapshot,
    });
  });

  it("shows Team only from confirmed Team entitlement", () => {
    expect(
      resolveSidebarFooterProfilePlanBadge({
        hasTeamPlanEntitlement: true,
        individualEntitlements: [
          {
            providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            snapshot: null,
          },
        ],
      }),
    ).toEqual({
      audience: "team",
    });
  });

  it("keeps stale BigModel Team Plan state out of the profile badge under Z.ai domain", () => {
    mockFooterSettings.current = {
      providerFamilyDomain: "zai",
      modelProviderFamilySelectedKeys: {
        bigmodel: "team:bigmodel:team-a:project-a",
      },
    };

    const html = renderToStaticMarkup(
      createElement(WorkspaceSidebarFooter, {
        theme: "dark",
        localeMenuValue: "zh-CN",
        onLocaleChange: () => {},
        onThemeChange: () => {},
        onSettingsButtonClick: () => {},
        user: {
          id: "user-zai-domain",
          username: "zai-user",
          displayName: "Zai User",
        },
      }),
    );

    expect(html).not.toContain("sidebar.usage.plan.audienceTeam");
  });

  it("waits for personal Coding Plan entitlement before showing Team", () => {
    expect(
      resolveSidebarFooterProfilePlanBadge({
        hasTeamPlanEntitlement: true,
        individualEntitlements: [
          {
            providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            snapshot: null,
            loading: true,
          },
        ],
      }),
    ).toBeNull();
  });

  it("does not show Team from a selected Team Plan key without Team entitlement", () => {
    expect(
      resolveSidebarFooterProfilePlanBadge({
        hasTeamPlanEntitlement: false,
        individualEntitlements: [
          {
            providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            snapshot: null,
            loading: false,
          },
        ],
      }),
    ).toBeNull();
  });

  it("resolves sidebar usage to the current workspace connection only", () => {
    const teamSources = [
      {
        id: "team:bigmodel:team-a:org-a:project-a" as const,
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
        label: "BigModel - Team A",
        accountAccess: {
          type: "zhipu-account" as const,
          family: "bigmodel" as const,
          planKind: "team-coding-plan" as const,
          productId: "team-a",
          organizationId: "org-a",
          projectId: "project-a",
        },
      },
      {
        id: "team:bigmodel:team-b:org-b:project-b" as const,
        providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
        label: "Team B Plan",
        accountAccess: {
          type: "zhipu-account" as const,
          family: "bigmodel" as const,
          planKind: "team-coding-plan" as const,
          productId: "team-b",
          organizationId: "org-b",
          projectId: "project-b",
        },
      },
    ];

    expect(
      resolveSidebarCurrentCodingPlanUsageSource({
        selections: {
          bigmodel: {
            kind: "team-coding-plan",
            productId: "team-b",
            organizationId: "org-b",
            projectId: "project-b",
          },
        },
        selectedProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
        accountAccesses: {
          bigmodel: {
            type: "zhipu-account",
            family: "bigmodel",
            mode: "individual-coding-plan",
          },
        },
        teamSources,
      }),
    ).toMatchObject({
      audience: "team",
      sourceId: "team:bigmodel:team-b:org-b:project-b",
      teamSource: { accountAccess: { projectId: "project-b" } },
    });
    expect(
      resolveSidebarCurrentCodingPlanUsageSource({
        selections: { bigmodel: { kind: "individual-coding-plan" } },
        selectedProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
        accountAccesses: {
          bigmodel: {
            type: "zhipu-account",
            family: "bigmodel",
            mode: "individual-coding-plan",
          },
        },
        teamSources,
      }),
    ).toMatchObject({
      audience: "individual",
      sourceId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
    });
  });

  it("does not guess a Team usage source after its product identity changes", () => {
    expect(
      resolveSidebarCurrentCodingPlanUsageSource({
        selections: {
          bigmodel: {
            kind: "team-coding-plan",
            productId: "product-old",
            organizationId: "org-a",
            projectId: "project-a",
          },
        },
        selectedProviderId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
        accountAccesses: {
          bigmodel: {
            type: "zhipu-account",
            family: "bigmodel",
            planKind: "individual-coding-plan",
          },
        },
        teamSources: [
          {
            id: "team:bigmodel:product-current:org-a:project-a",
            providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
            label: "BigModel - Team A",
            accountAccess: {
              type: "zhipu-account",
              family: "bigmodel",
              planKind: "team-coding-plan",
              productId: "product-current",
              organizationId: "org-a",
              projectId: "project-a",
            },
          },
        ],
      }),
    ).toBeNull();
  });

  it("does not wrap the remote control trigger in a second tooltip", () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceSidebarFooter, {
        theme: "dark",
        localeMenuValue: "zh-CN",
        onLocaleChange: () => {},
        onThemeChange: () => {},
        onSettingsButtonClick: () => {},
        workspacePath: "/tmp/project",
        isDesktop: true,
      }),
    );

    expect(html).toContain('data-testid="web-remote-control-trigger"');
    expect(html).not.toContain('data-tooltip-title="webRemoteControl.trigger"');
  });

  it("shows desktop zoom commands under an interface zoom submenu", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WorkspaceSidebarFooter.tsx"),
      "utf8",
    );

    expect(source).toContain("{isDesktop ? (");
    expect(source).toContain('id: "sidebar.settings.interfaceZoom"');
    expect(source).toContain("<DropdownMenuSubContent");
    expect(source).toContain("DesktopCommandIds.ZoomIn");
    expect(source).toContain("DesktopCommandIds.ZoomOut");
    expect(source).toContain("DesktopCommandIds.ResetZoom");
    expect(source).toContain('id: "titleBar.menu.view.zoomIn"');
    expect(source).toContain('id: "titleBar.menu.view.zoomOut"');
    expect(source).toContain('id: "titleBar.menu.view.actualSize"');
  });

  it("keeps the interface zoom submenu gated to desktop mode", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WorkspaceSidebarFooter.tsx"),
      "utf8",
    );

    expect(source).toContain("{isDesktop ? (");
    expect(source).toContain(") : null}");
  });

  it("keeps profile menu grouped as language theme zoom usage auth", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WorkspaceSidebarFooter.tsx"),
      "utf8",
    );

    const localeIndex = source.indexOf('id: "settings.locale"');
    const themeIndex = source.indexOf('id: "settings.themeMode"');
    const zoomIndex = source.indexOf('id: "sidebar.settings.interfaceZoom"');
    const usageIndex = source.indexOf("<WorkspaceSidebarFooterUsageSummary");
    const loginIndex = source.indexOf('id: "app.login"');
    const logoutIndex = source.indexOf('id: "app.logout"');
    const separatorBeforeAuthIndex = source.indexOf("<DropdownMenuSeparator />", usageIndex);

    expect(localeIndex).toBeGreaterThan(-1);
    expect(themeIndex).toBeGreaterThan(localeIndex);
    expect(zoomIndex).toBeGreaterThan(themeIndex);
    expect(usageIndex).toBeGreaterThan(zoomIndex);
    expect(separatorBeforeAuthIndex).toBeGreaterThan(usageIndex);
    expect(loginIndex).toBeGreaterThan(separatorBeforeAuthIndex);
    expect(logoutIndex).toBeGreaterThan(separatorBeforeAuthIndex);
  });

  it("keeps the always-visible upgrade entry inside the footer summary", () => {
    const footerSource = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WorkspaceSidebarFooter.tsx"),
      "utf8",
    );
    const summarySource = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx"),
      "utf8",
    );
    const usageIndex = footerSource.indexOf("<WorkspaceSidebarFooterUsageSummary");

    // 偏好设置与用量之间由 summary 统一管理分隔线，账号操作组另有分隔线。
    const preferencesIndex = footerSource.indexOf('id: "settings.locale"');
    expect(footerSource.slice(preferencesIndex, usageIndex)).not.toContain(
      "<DropdownMenuSeparator />",
    );
    expect(summarySource).toContain("<DropdownMenuSeparator />");
    expect(summarySource.indexOf("sidebar.usage.plan.openStats")).toBeLessThan(
      summarySource.indexOf("onUpgradeClick?.("),
    );
    expect(summarySource).toContain("setPendingSettingsUsageIntent();");
    expect(summarySource).toContain("onUsageClick?.();");
    expect(summarySource).toContain("upgradeTargetProviderId");
    expect(summarySource).toContain("onUpgradeClick?.(");
    expect(summarySource).not.toContain("if (!upgradeProviderId");
    expect(summarySource).not.toContain("if (!upgradeTargetProviderId");
    expect(summarySource).toContain("<DropdownMenuSeparator />");
    expect(summarySource).not.toContain("<CodingPlanUsageRemainingPanel");
  });

  it("keeps settings-page usage stats separate from the back button", () => {
    const footerSource = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WorkspaceSidebarFooter.tsx"),
      "utf8",
    );
    const settingsSource = readFileSync(
      resolve(process.cwd(), "packages/ui/src/SettingsPage.tsx"),
      "utf8",
    );

    expect(footerSource).toContain("onUsageClick,");
    expect(footerSource).toContain(
      "const usageButtonClick = onUsageClick ?? onSettingsButtonClick;",
    );
    expect(footerSource).toContain("onUsageClick={usageButtonClick}");
    expect(settingsSource).toContain("const handleOpenUsageSettings = useCallback(() => {");
    expect(settingsSource).toContain('setActiveSettingsSection("usage");');
    expect(settingsSource).toContain("onSettingsButtonClick={onBack}");
    expect(settingsSource).toContain("onUsageClick={handleOpenUsageSettings}");
  });

  it("keeps duplicated help actions out of the profile menu", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WorkspaceSidebarFooter.tsx"),
      "utf8",
    );

    expect(source).not.toContain('id: "titleBar.menu.help.feedback"');
    expect(source).not.toContain('id: "sidebar.menu.community"');
    expect(source).not.toContain('id: "titleBar.menu.help.exportLogs"');
    expect(source).not.toContain("<DropdownMenuItem onSelect={onSettingsButtonClick}>");
    expect(source).not.toContain("runExportLogsAction");
  });

  it("keeps usage remaining mounted across profile menu toggles", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WorkspaceSidebarFooter.tsx"),
      "utf8",
    );

    // 此用例验证菜单保持挂载，不应绑定会随国际化文案调整的宽度。
    expect(source).toMatch(/<DropdownMenuContent\b[^>]*\bforceMount\s*>/);
    expect(source).toContain("<WorkspaceSidebarFooterUsageSummary");
    expect(source).toContain("enabled");
    expect(source).not.toContain("enabled={profileMenuOpen}");
  });

  it("renders the profile plan badge from the shared usage summary state", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/WorkspaceSidebarFooter.tsx"),
      "utf8",
    );

    expect(source).toContain("useWorkspaceSidebarFooterUsageSummaryState");
    expect(source).toContain("<WorkspaceSidebarFooterPlanBadge state={usageSummaryState} />");
    expect(source).toContain("<WorkspaceSidebarFooterUsageSummaryContent");
    expect(source).toContain("state={usageSummaryState}");
  });
});
