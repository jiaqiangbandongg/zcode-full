import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  ProviderFamilyHeader,
  ProviderFamilyPlanModeSwitch,
} from "@/settings/model-provider-section/ProviderFamilyModeHeader.js";
import type { ModelProviderNavItem } from "@/settings/model-provider-section/constants.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const name = params.get("name") ?? "北京智谱华章科技股份有限公司";
const common = {
  oauthProviderId: "bigmodel" as const,
  label: name,
  providerName: "BigModel",
  provider: null,
  status: "purchased" as const,
  statusActive: true,
};
const items: ModelProviderNavItem[] = [
  {
    ...common,
    key: "team",
    type: "teamPlan",
    presetId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelCodingPlan,
    teamPlanName: name,
  },
  {
    ...common,
    key: "start",
    type: "codingPlan",
    presetId: BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
  },
];
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";

function Fixture() {
  const [selected, setSelected] = useState(items[0]!);
  return (
    <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
      <main
        style={{
          padding: 16,
          width: "100%",
          minHeight: "100vh",
          maxWidth: Number(params.get("panel") ?? 1000),
          background: "var(--color-background)",
          color: "var(--color-foreground)",
        }}
      >
        <section data-testid="panel" style={{ marginLeft: 48, padding: 16 }}>
          <ProviderFamilyHeader
            selectedNavItem={selected}
            trailingAction={
              <ProviderFamilyPlanModeSwitch
                selectedNavItem={selected}
                navigationItems={items}
                startPlanSubscriptionCount={1}
                onSelectNavItem={setSelected}
              />
            }
          />
        </section>
        <output data-testid="selected">{selected.key}</output>
      </main>
    </ZCodeIntlProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Fixture />
  </TooltipProvider>,
);
