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

vi.mock("@/ControlHintTooltip.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/ControlHintTooltip.js")>()),
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
});
