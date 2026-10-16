import { StrictMode, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IUsageStatsService } from "@zcode/services";
import { BUILTIN_MODEL_PROVIDER_IDS, type UsageEntitlementSnapshot } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useUsageEntitlementWithService } from "@/hooks/useUsageEntitlement.js";
import { useV4SessionQuotaBanner } from "@/v4/useV4SessionQuotaBanner.js";
import { ConversationQuotaBanner } from "@/v4/ConversationQuotaBanner.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const providerId = BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
document.documentElement.className =
  query.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";
const end = 4_102_444_800_000;
function snapshot(
  event: number,
  daily: number,
  other: number,
  cycle: number,
): UsageEntitlementSnapshot {
  return {
    generatedAt: Date.now(),
    serverTime: Number(query.get("serverTime")) || Date.now(),
    authenticated: true,
    provider: { id: providerId, name: "Start" },
    remaining: null,
    subscription: null,
    quota: {
      level: "Start",
      limits: [
        {
          type: "event",
          bucketId: "fixture-event",
          period: "one_time",
          number: 300_000_000,
          remaining: event * 3_000_000,
          percentage: event / 100,
          periodStart: 0,
          periodEnd: end,
          nextResetTime: end,
          usageDetails: [{ modelCode: "glm-flash", displayName: "GLM Flash", usage: 0 }],
        },
        {
          type: "daily",
          bucketId: "fixture-daily",
          period: "daily",
          number: 5_000_000,
          remaining: daily * 50_000,
          percentage: daily / 100,
          periodStart: cycle,
          periodEnd: end + cycle,
          nextResetTime: end + cycle,
          usageDetails: [{ modelCode: "glm-flash", displayName: "GLM Flash", usage: 0 }],
        },
        {
          type: "other",
          bucketId: "fixture-other",
          period: "daily",
          number: 3_000_000,
          remaining: other * 30_000,
          percentage: other / 100,
          periodStart: 0,
          periodEnd: end,
          nextResetTime: end,
          usageDetails: [{ modelCode: "glm-other", usage: 0 }],
        },
      ],
    },
  };
}
function Pane({ service, session }: { service: IUsageStatsService; session: string }) {
  const banner = useV4SessionQuotaBanner({
    sessionId: session,
    error: null,
    errorKey: null,
    phase: "idle",
    providerId,
    modelId: "glm-flash",
    usageStatsService: service,
  });
  return (
    <section data-testid="pane">
      <output data-testid="kind">{banner.state.kind ?? "none"}</output>
      {banner.state.visible && !banner.dismissed ? (
        <ConversationQuotaBanner
          state={banner.state}
          onShown={banner.markShown}
          onDismiss={banner.dismiss}
          onUpgrade={() => {
            document.body.dataset.upgraded = "true";
          }}
        />
      ) : null}
    </section>
  );
}
function Fixture() {
  const values = useRef({ event: 100, daily: 100, other: 100, cycle: 0 });
  const [session, setSession] = useState("a");
  const [mounted, setMounted] = useState(true);
  const [revision, setRevision] = useState(0);
  const service = useMemo(
    () =>
      ({
        getEntitlementSnapshot: async () => {
          const value = values.current;
          return snapshot(value.event, value.daily, value.other, value.cycle);
        },
      }) as unknown as IUsageStatsService,
    [],
  );
  const entitlement = useUsageEntitlementWithService(service, {
    preferredProviderId: providerId,
    enabled: true,
    includeSubscription: false,
    allowDisabledPreferredProvider: true,
    requirePreferredProvider: true,
    allowEnvApiKey: false,
    refreshOnMount: true,
  });
  async function refresh() {
    await entitlement.refresh({ force: true });
    setRevision((v) => v + 1);
  }
  return (
    <ZCodeIntlProvider initialLocale={query.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
      <main className="min-h-screen bg-background p-4 text-ui-base text-foreground">
        {(["event", "daily", "other"] as const).map((key) => (
          <label key={key}>
            {key}
            <select
              data-testid={key}
              defaultValue="100"
              onChange={(event) => {
                values.current[key] = Number(event.target.value);
                void refresh();
              }}
            >
              {[100, 50, 48, 47, 20, 10.1, 10, 9, 0].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
        ))}
        <button
          onClick={() => {
            values.current.cycle += 1;
            void refresh();
          }}
        >
          New cycle
        </button>
        <button onClick={() => setSession((v) => (v === "a" ? "b" : "a"))}>Switch task</button>
        <button onClick={() => setMounted((v) => !v)}>Toggle pane</button>
        <output data-testid="revision">{revision}</output>
        <output data-testid="session">{session}</output>
        {mounted ? <Pane service={service} session={session} /> : null}
      </main>
    </ZCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
