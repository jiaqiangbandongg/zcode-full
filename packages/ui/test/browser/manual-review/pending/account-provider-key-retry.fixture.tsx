import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { CodingPlanStatusPanel } from "@/settings/model-provider-section/StatusCards.js";
import { resolveCodingPlanEntitlementState } from "@/settings/model-provider-section/providerFamilyConnectionVisibility.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const providerId =
  params.get("family") === "zai"
    ? BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan
    : BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan;
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";

function Fixture() {
  const [refreshing, setRefreshing] = useState(false);
  const [reason, setReason] = useState<"credential-failed" | "not-entitled">("credential-failed");
  const [requests, setRequests] = useState(0);
  const [logins, setLogins] = useState(0);
  const state = resolveCodingPlanEntitlementState({
    providerId,
    accountEntitled: false,
    accountAvailability: "unavailable",
    accountUnavailableReason: reason,
    modelProvidersLoading: false,
  });
  async function retry() {
    setRefreshing(true);
    setRequests((value) => value + 1);
    try {
      // 用受控网络响应验证真实按钮的异步交互；不模拟生产 OAuth 登录成功。
      const response = await fetch("/retry", { method: "POST" });
      if (response.ok) setReason("not-entitled");
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
      <main className="min-h-screen bg-background p-4 text-ui-base text-foreground">
        <CodingPlanStatusPanel
          providerId={providerId}
          providerName={params.get("family") ?? "Provider"}
          status={state.status}
          loginLoading={refreshing}
          loginActionVisible
          loginActionPlacement="trailing"
          reloginOnFailure
          onLogin={(options) => {
            if (options?.forceOAuth !== true) throw new Error("重新登录必须强制 OAuth");
            setLogins((value) => value + 1);
            void retry();
          }}
        />
        <output data-testid="requests">{requests}</output>
        <output data-testid="logins">{logins}</output>
      </main>
    </ZCodeIntlProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Fixture />
  </TooltipProvider>,
);
