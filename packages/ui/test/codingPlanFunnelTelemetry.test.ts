import { describe, expect, it, vi } from "vitest";
import type { ProviderSettingsProviderView, ProviderSettingsView } from "@zcode/services";
import { BUILTIN_MODEL_PROVIDER_IDS, type IPlatformService } from "@zcode/shared";
import { reportPresetSubscriptionSuccess } from "@/settings/model-provider-section/oauthActions.js";
import { buildCodingPlanEmbeddedReportContext } from "@/settings/model-provider-section/codingPlanEmbeddedWebview.js";
import {
  createIdleTimeCodingPlanFunnelContext,
  reportCodingPlanUpgradeClick,
  createCodingPlanFunnelContext,
  resolveCodingPlanEntryPlanState,
  resolveCodingPlanEntryPlanStateFromProviderSettings,
} from "@/lib/codingPlanFunnelTelemetry.js";

function createProviderSettingsView(
  providers: readonly ProviderSettingsProviderView[],
): ProviderSettingsView {
  return { revision: 1, addableProviders: [], providerOrder: [], providers };
}

function createAccountProviderView(
  providerId: string,
  entitled = true,
  enabled = true,
): ProviderSettingsProviderView {
  return {
    providerId,
    enabled,
    executable: enabled && entitled,
    effectiveConfig: {
      access: {
        type: "zhipu-account",
        accountType: providerId.includes("zai") ? "zai" : "bigmodel",
        mode: providerId.includes("start-plan")
          ? "start-plan"
          : providerId.includes("team-")
            ? "team-coding-plan"
            : "individual-coding-plan",
        entitled,
      },
      label: providerId,
      api: {
        type: "anthropic-messages",
        baseUrl: "https://example.com",
      },
      builtinModelIds: ["model-a"],
      enabled,
    },
    issues: entitled
      ? []
      : [
          {
            code: "required-field",
            path: ["providers", providerId, "connection"],
            message: "account connection required",
          },
        ],
    models: [],
  };
}

describe("codingPlanFunnelTelemetry", () => {
  it.each(Object.values(BUILTIN_MODEL_PROVIDER_IDS))(
    "%s 真实成功 builder 与漏斗 bootstrap 标签一致",
    async (presetId) => {
      const reportTelemetryEvent = vi.fn(async () => {});
      const platform = { reportTelemetryEvent } as unknown as IPlatformService;
      await reportPresetSubscriptionSuccess({ platform, presetId });
      const family = presetId.includes("bigmodel") ? "bigmodel" : "zai";
      expect(reportTelemetryEvent).toHaveBeenCalledTimes(1);
      expect(reportTelemetryEvent.mock.calls[0][0]).toMatchObject({
        elementName: "add_model_success",
        eventExtraDetail: { model_provider: family === "zai" ? "z.ai" : "bigmodel" },
      });
      reportTelemetryEvent.mockClear();
      const context = createCodingPlanFunnelContext({
        providerId: presetId,
        upgradeSource: "setting_team_plan_banner",
        eventRegion: "app.setting",
        eventText: "升级",
        purchaseAudience: "team",
        entryPlanState: {
          entryPlanStatus: presetId.includes("start-plan") ? "start_plan" : "coding_plan",
          entryPlanLevel: "Team Pro",
        },
      });
      context.entryPlanList = "existing-list";
      reportCodingPlanUpgradeClick(platform, context);
      const webview = buildCodingPlanEmbeddedReportContext({ funnelContext: context });
      expect(reportTelemetryEvent).toHaveBeenCalledTimes(1);
      expect(webview).toMatchObject({
        purchase_funnel_id: context.purchaseFunnelId,
        provider_family: family,
        channel: family === "zai" ? "Z_AI" : "MaaS",
        entry_plan_level: "Team Pro",
        entry_plan_list: "existing-list",
        purchase_audience: "team",
        purchase_entry_reporter: "app",
      });
      expect(reportTelemetryEvent.mock.calls[0][0].eventExtraDetail).toMatchObject({
        purchase_funnel_id: context.purchaseFunnelId,
        provider_family: webview.provider_family,
        channel: webview.channel,
        entry_plan_status: webview.entry_plan_status,
      });
    },
  );
  it.each(["zai", "bigmodel"])(
    "%s Team-only 按权益识别，不按 enabled，漏斗 family 完整",
    (family) => {
      const providerId = `account:${family}-team-coding-plan`;
      expect(
        resolveCodingPlanEntryPlanStateFromProviderSettings(
          createProviderSettingsView([createAccountProviderView(providerId, true, false)]),
        ),
      ).toEqual({ entryPlanStatus: "coding_plan", entryPlanLevel: "" });
      expect(
        resolveCodingPlanEntryPlanStateFromProviderSettings(
          createProviderSettingsView([createAccountProviderView(providerId, false)]),
        ),
      ).toEqual({ entryPlanStatus: "no_plan", entryPlanLevel: "" });
      expect(
        createCodingPlanFunnelContext({
          providerId,
          upgradeSource: "setting_team_plan_banner",
          eventRegion: "app.setting",
          eventText: "升级",
        }),
      ).toMatchObject({ providerFamily: family, channel: family === "bigmodel" ? "MaaS" : "Z_AI" });
    },
  );
  it("leaves the owned plan inventory to the provider instead of inferring it from the entry card", () => {
    const context = createCodingPlanFunnelContext({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
      upgradeSource: "setting_plan_card",
      eventRegion: "app.setting",
      eventText: "Upgrade",
      entryPlanState: { entryPlanStatus: "coding_plan", entryPlanLevel: "Team Pro" },
    });
    expect(context.entryPlanList).toBe("");
    expect(context.entryPlanLevel).toBe("Team Pro");
  });

  it("resolves entry plan state from entitlement snapshots and settings status", () => {
    expect(
      resolveCodingPlanEntryPlanState({
        snapshot: {
          generatedAt: 1,
          authenticated: true,
          unavailableReason: "no_plan",
          provider: {
            id: BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            name: "BigModel",
          },
          remaining: null,
          quota: null,
          subscription: null,
        },
      }),
    ).toEqual({ entryPlanStatus: "no_plan", entryPlanLevel: "" });

    expect(
      resolveCodingPlanEntryPlanState({
        displayStatus: "purchased",
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        planLevel: "GLM Coding Pro",
      }),
    ).toEqual({ entryPlanStatus: "coding_plan", entryPlanLevel: "GLM Coding Pro" });

    expect(
      resolveCodingPlanEntryPlanState({
        displayStatus: "purchased",
        providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan,
        planLevel: "Start Plan",
      }),
    ).toEqual({ entryPlanStatus: "start_plan", entryPlanLevel: "Start Plan" });
  });

  it("resolves the idle-time entry plan state from account access in Provider Settings", () => {
    expect(resolveCodingPlanEntryPlanStateFromProviderSettings(null)).toEqual({
      entryPlanStatus: "unknown",
      entryPlanLevel: "",
    });

    expect(
      resolveCodingPlanEntryPlanStateFromProviderSettings(
        createProviderSettingsView([
          createAccountProviderView(BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan),
        ]),
      ),
    ).toEqual({ entryPlanStatus: "start_plan", entryPlanLevel: "start" });

    expect(
      resolveCodingPlanEntryPlanStateFromProviderSettings(
        createProviderSettingsView([
          createAccountProviderView(BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan),
          createAccountProviderView(
            BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            false,
            true,
          ),
        ]),
      ),
    ).toEqual({ entryPlanStatus: "start_plan", entryPlanLevel: "start" });

    expect(
      resolveCodingPlanEntryPlanStateFromProviderSettings(
        createProviderSettingsView([
          createAccountProviderView(
            BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan,
            false,
            true,
          ),
        ]),
      ),
    ).toEqual({ entryPlanStatus: "no_plan", entryPlanLevel: "" });
  });

  it("reports the idle-time Upgrade entry with the complete shared funnel context", () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "2a3f0a1e-1234-5678-9012-acde12345678",
    );
    const reportTelemetryEvent = vi.fn(async () => {});
    const context = createIdleTimeCodingPlanFunnelContext({
      providerId: BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
      eventText: "升级",
      entryPlanState: {
        entryPlanStatus: "start_plan",
        entryPlanLevel: "start",
      },
    });

    reportCodingPlanUpgradeClick(
      { reportTelemetryEvent },
      {
        ...context,
        entryPlanList: "coding_plan__personal_lite,start_plan__start",
      },
    );

    expect(reportTelemetryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "ck",
        eventRegion: "app.session",
        elementName: "coding_plan_upgrade_ck",
        eventText: "升级",
        eventExtraDetail: {
          purchase_funnel_id: "2a3f0a1e-1234-5678-9012-acde12345678",
          upgrade_source: "session_idle_time",
          entry_plan_status: "start_plan",
          entry_plan_level: "start",
          entry_plan_list: "coding_plan__personal_lite,start_plan__start",
          purchase_audience: "personal",
          provider_family: "zai",
          channel: "Z_AI",
        },
      }),
    );
  });
});
