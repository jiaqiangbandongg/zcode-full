import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IBroadcastService, IServiceAccessor } from "@zcode/services";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { usePluginStoreOrder } from "@/hooks/usePluginStoreOrder.js";
import { StoreContext } from "@/store/StoreProvider.js";
import { createZCodeStore } from "@/store/index.js";
import { PluginStoreListView, type PluginStoreSegment } from "@/settings/PluginStoreListView.js";
import { buildStoreItems, type StorePluginItem } from "@/settings/pluginStoreListing.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const broadcast: IBroadcastService = {
  send: async () => {},
  onMessage: () => ({ dispose() {} }),
  acquireClaim: async () => ({ status: "unavailable" }),
  commitClaim: async () => {},
  releaseClaim: async () => {},
  tryClaim: async () => false,
};
const store = createZCodeStore(broadcast);
store.getState().setInterfaceMode("coding");
store.getState().setTheme(params.get("theme") === "light" ? "light" : "dark");
const official = "zcode-plugins-official";
function item(name: string, category: string, marketplace = official): StorePluginItem {
  return {
    id: `${name}@${marketplace}`,
    name,
    marketplace,
    installed: false,
    restorable: false,
    orphaned: false,
    listing: { category },
  };
}
const items =
  params.get("documentOrder") === "1"
    ? ["aaa", "documents", "spreadsheets", "presentations", "pdf"].map((name) => ({
        ...item(name, "productivity"),
        installed: true,
      }))
    : params.get("missingConfig") === "1"
      ? buildStoreItems({
          marketplaces: [],
          marketplaceAvailabilityKnown: true,
          installedPlugins: [],
          restorableBuiltins: [],
          availablePlugins: [
            "plugin-creator",
            "documents",
            "pdf",
            "presentations",
            "spreadsheets",
            "image-search",
            "repairable",
          ].map((name) => ({
            id: `${name}@${official}`,
            name,
            marketplace: official,
            installed: name !== "repairable",
            listing: { category: "productivity" },
          })),
          plugins: ["document-skills", "repairable"].map((name) => ({
            id: `${name}@${official}`,
            name,
            marketplace: official,
            enabled: true,
            source: "missing" as const,
            packageStatus: "missing" as const,
            rootPath: "",
            skillCount: 0,
            skillRootCount: 0,
            commandRootCount: 0,
            components: [],
            declaredMcpServerNames: [],
            mcpServerNames: [],
            enabledSource: "user" as const,
          })),
        })
      : [
          item("dev", "developer-tools"),
          item("other", "other"),
          item("legacy-guide", "guides"),
          { ...item("restore-legacy-sessions", "utilities"), installed: true },
          ...(params.get("retired") === "1"
            ? [item("restore-legacy-sessions", "utilities", "personal")]
            : []),
          ...(params.get("legal") === "1" ? [item("legal-example", "legal")] : []),
          ...Array.from({ length: 8 }, (_, i) => item(`p${i}`, "productivity")),
          item("personal-b", "productivity", "personal"),
          item("personal-a", "productivity", "personal"),
        ];
let requests = 0;
const services = {
  clientConfigService: {
    getSnapshot: async () => {
      requests += 1;
      const response = await fetch("/order");
      if (!response.ok) throw new Error("offline");
      return { pluginStoreOrder: await response.json() };
    },
  },
} as unknown as IServiceAccessor;

function Fixture() {
  const { order, refresh } = usePluginStoreOrder();
  const [query, setQuery] = useState("");
  const [segment, setSegment] = useState<PluginStoreSegment>("public");
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <button data-testid="code" onClick={() => store.getState().setInterfaceMode("coding")}>
        Code
      </button>
      <button data-testid="work" onClick={() => store.getState().setInterfaceMode("general")}>
        Work
      </button>
      <button data-testid="refresh" onClick={() => void refresh(true)}>
        Refresh
      </button>
      <output data-testid="requests">{requests}</output>
      <PluginStoreListView
        items={items}
        order={order}
        marketplaces={[
          {
            id: official,
            name: official,
            source: {},
            pluginCount: 10,
            featured: ["p1", "restore-legacy-sessions", "p0"],
          },
        ]}
        loading={false}
        query={query}
        onQueryChange={setQuery}
        segment={segment}
        onSegmentChange={setSegment}
        onOpenManage={() => {}}
        actions={{
          onOpenDetail: () => {},
          onUpdate: () => {},
          onInstall: () => {},
          onUninstall: () => {},
          onSetEnabled: () => {},
          operationId: null,
          togglingPluginId: null,
        }}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <StoreContext.Provider value={store}>
      <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
        <TooltipProvider>
          <Fixture />
        </TooltipProvider>
      </ZCodeIntlProvider>
    </StoreContext.Provider>
  </ServiceProvider>,
);
