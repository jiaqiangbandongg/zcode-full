import { useState } from "react";
import { createRoot } from "react-dom/client";
import { getModelProviderFamilySpec } from "@zcode/shared";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import { CodingPlanStatusPanel } from "@/settings/model-provider-section/StatusCards.js";
import { ProviderFamilyPlanModeSwitch } from "@/settings/model-provider-section/ProviderFamilyModeHeader.js";
import type {
  ModelProviderNavItem,
  CodingPlanStatus,
} from "@/settings/model-provider-section/constants.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { formatModelChangeLabel } from "@/v4/composer/modelTriggerDisplay.js";
import "@/styles.css";
const params = new URLSearchParams(location.search);
const family = getModelProviderFamilySpec(params.get("family") === "zai" ? "zai" : "bigmodel");
const state = params.get("state") ?? "disconnected";
const status: CodingPlanStatus =
  state === "empty" || state === "pending"
    ? "purchased"
    : state === "expired"
      ? "unavailable"
      : (state as CodingPlanStatus);
const common = {
  oauthProviderId: family.oauthProviderId,
  label: "Team",
  providerName: family.id,
  provider: null,
  status: "purchased" as const,
  statusActive: true,
};
const items: ModelProviderNavItem[] = [
  {
    ...common,
    key: "team",
    type: "teamPlan",
    presetId: family.teamCodingPlanProviderId,
    teamPlanName: "InternationalResearchAndDevelopmentOrganization 北京智谱团队",
    currentProductId: "p",
    organizationId: "o",
    projectId: "j",
  },
  {
    ...common,
    key: "personal",
    type: "codingPlan",
    presetId: family.individualCodingPlanProviderId,
  },
];
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";
function Fixture() {
  const { intl } = useZCodeIntl();
  const [selected, setSelected] = useState(items[0]!);
  const [actions, setActions] = useState(0);
  return (
    <main className="min-h-screen bg-background p-4 text-ui-base text-foreground">
      <section className="mx-auto max-w-2xl space-y-4" data-testid="panel">
        <ProviderFamilyPlanModeSwitch
          selectedNavItem={selected}
          navigationItems={items}
          onSelectNavItem={setSelected}
          connectionSelections={{
            [family.id]:
              selected.key === "team"
                ? { kind: "team-coding-plan", productId: "p", organizationId: "o", projectId: "j" }
                : { kind: "individual-coding-plan" },
          }}
        />
        <CodingPlanStatusPanel
          providerId={family.startPlanProviderId}
          providerName={family.id}
          status={status}
          statusLabelId={
            state === "expired" ? "settings.modelProvider.startPlan.status.loginExpired" : undefined
          }
          loginActionVisible
          loginActionPlacement="trailing"
          onLogin={() => setActions((x) => x + 1)}
          onRetry={state === "unavailable" ? () => setActions((x) => x + 1) : undefined}
          startPlanPreviewVisible={false}
          planLevel="Start"
          subscriptionDetails={
            status === "purchased"
              ? [
                  {
                    productId: "start",
                    productName: "Start Plan",
                    purchaseTime: null,
                    beginTime: null,
                    expireTime: null,
                    entitlements:
                      state === "pending"
                        ? [
                            {
                              entitlementId: "scheduled",
                              effectiveTime: new Date(Date.now() + 3600000).toISOString(),
                            },
                          ]
                        : [],
                  },
                ]
              : []
          }
          quotaLimits={
            status === "purchased" && state !== "pending"
              ? [
                  {
                    type: "tokens",
                    planId: "start",
                    number: 3000000,
                    remaining: state === "empty" ? 0 : 1500000,
                    usageDetails: [{ modelCode: "GLM-5.3" }],
                  },
                ]
              : []
          }
        />
        <p data-testid="model-label">
          {formatModelChangeLabel(family.teamCodingPlanProviderId, undefined, "GLM-5.3", intl)} →{" "}
          {formatModelChangeLabel(family.startPlanProviderId, undefined, "GLM-5.3", intl)}
        </p>
        <output data-testid="actions">{actions}</output>
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
