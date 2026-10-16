import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  normalizeCodingPlanProviderId,
  resolveCodingPlanOAuthProviderId,
} from "@/settings/model-provider-section/codingPlanPurchaseAuth.js";
import { CODING_PLAN_PROVIDER_SPECS } from "@/settings/model-provider-section/constants.js";

function readSource(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("settings model provider upgrade intent", () => {
  it("opens Settings upgrade entries through the dialog hook", () => {
    const settingsPageSource = readSource("packages/ui/src/SettingsPage.tsx");
    const modelProviderSectionSource = readSource(
      "packages/ui/src/settings/ModelProviderSection.tsx",
    );
    const detailSource = readSource("packages/ui/src/settings/model-provider-section/Detail.tsx");
    const statusCardsSource = readSource(
      "packages/ui/src/settings/model-provider-section/StatusCards.tsx",
    );

    expect(settingsPageSource).toContain("useCodingPlanUpgradeDialog");
    expect(settingsPageSource).toContain("openCodingPlanUpgrade({");
    expect(settingsPageSource).not.toContain("<CodingPlanUpgradeDialog");
    expect(settingsPageSource).not.toContain("codingPlanUpgradeProviderId");
    // 修复原因：JSX 格式化可能把属性换行，断言应验证绑定语义而不是排版。
    expect(settingsPageSource).toMatch(
      /pendingModelProviderTarget=\{\s*pendingModelProviderTarget\s*\}/,
    );
    expect(modelProviderSectionSource).toContain("pendingModelProviderTarget");
    expect(modelProviderSectionSource).toContain("applyModelProviderTarget");
    expect(modelProviderSectionSource).not.toContain("onOpenCodingPlanUpgrade");
    expect(detailSource).toContain("useCodingPlanUpgradeDialog");
    expect(detailSource).toContain("openCodingPlanUpgrade({");
    expect(statusCardsSource).toContain("onOpenUpgradePlans");
    expect(statusCardsSource).toContain("由弹窗 hook 承载购买面板");
    expect(statusCardsSource).not.toContain('openUpgradePlans(\n            "personal"');
    expect(detailSource).toContain("initialTeamPlanKey:");
    expect(statusCardsSource).toContain(
      'isStartPlanProvider ? "setting_start_plan_card" : "setting_plan_card"',
    );
    expect(statusCardsSource).toContain("disabled={effectiveViewState.loginLoading}");
  });

  it("keeps both Team Provider identities in the Coding Plan upgrade boundary", () => {
    expect(normalizeCodingPlanProviderId(BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan)).toBe(
      BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
    );
    expect(normalizeCodingPlanProviderId(BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan)).toBe(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
    );
    expect(resolveCodingPlanOAuthProviderId(BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan)).toBe(
      "zai",
    );
    expect(
      resolveCodingPlanOAuthProviderId(BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan),
    ).toBe("bigmodel");
    expect(CODING_PLAN_PROVIDER_SPECS.map((spec) => spec.id)).not.toContain(
      BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan,
    );
    expect(CODING_PLAN_PROVIDER_SPECS.map((spec) => spec.id)).not.toContain(
      BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan,
    );
  });

  it("opens workspace upgrade entries without switching to Settings", () => {
    const appSource = readSource("packages/ui/src/App.tsx");
    const rootSource = readSource("packages/ui/src/Root.tsx");
    const workspaceSidebarSource = readSource("packages/ui/src/WorkspaceSidebar.tsx");
    const v4ComposerToolbarSource = readSource("packages/ui/src/v4/composer/V4ComposerToolbar.tsx");
    const contextUsageSource = readSource("packages/ui/src/chat-input-toolbar/contextUsage.tsx");

    expect(appSource).not.toContain("handleOpenCodingPlanUpgrade");
    expect(appSource).not.toContain("<CodingPlanUpgradeDialog");
    expect(rootSource).toContain("<CodingPlanUpgradeDialogProvider>");
    expect(workspaceSidebarSource).toContain("useCodingPlanUpgradeDialog");
    expect(v4ComposerToolbarSource).toContain("useCodingPlanUpgradeDialog");
    expect(v4ComposerToolbarSource).toContain("openCodingPlanUpgrade({");
    expect(v4ComposerToolbarSource).toContain("startPlanBalance={contextStartPlanBalance}");
    expect(contextUsageSource).toContain("startPlanBalance.onUpgradeClick?.()");
    expect(workspaceSidebarSource).not.toContain("codingPlanUpgradeProviderId");
    expect(v4ComposerToolbarSource).not.toContain("codingPlanUpgradeProviderId");
  });

  it("routes both idle-time Upgrade entries through the shared purchase funnel context", () => {
    const offPeakNewTaskEntrySource = readSource("packages/ui/src/v4/OffPeakNewTaskEntry.tsx");
    const automationsSectionSource = readSource("packages/ui/src/settings/AutomationsSection.tsx");

    for (const source of [offPeakNewTaskEntrySource, automationsSectionSource]) {
      expect(source).toContain("createIdleTimeCodingPlanFunnelContext({");
      expect(source).toContain('initialAudience: "personal"');
      expect(source).toContain("funnelContext:");
    }
  });

  it("opens no-model Set action directly to model provider settings", () => {
    const composerToolbarSource = readSource("packages/ui/src/v4/composer/V4ComposerToolbar.tsx");

    expect(composerToolbarSource).toContain('setPendingSettingsSectionIntent("modelProvider")');
    expect(composerToolbarSource).toContain("handleOpenModelProviderSettings");
    expect(composerToolbarSource).toContain("onManageModels={handleOpenModelProviderSettings}");
    expect(composerToolbarSource).not.toContain("onManageModels={openSettingsTab}");
  });
});
