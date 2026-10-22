import { StoreContext } from "@/store/StoreProvider.js";
import { createZCodeStore } from "@/store/index.js";
import type { IBroadcastService } from "@zcode/services";
import { PluginStoreDetailView } from "@/settings/PluginStoreDetailView.js";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PluginStoreListView } from "@/settings/PluginStoreListView.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import "@/styles.css";

const store = createZCodeStore({
  send: async () => {},
  onMessage: () => ({ dispose() {} }),
  acquireClaim: async () => ({ status: "unavailable" }),
  commitClaim: async () => {},
  releaseClaim: async () => {},
  tryClaim: async () => false,
} as IBroadcastService);
const params = new URLSearchParams(location.search);
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";
const items: StorePluginItem[] = Array.from({ length: 12 }, (_, index) => {
  const name = `plugin-${String(index).padStart(2, "0")}`;
  return {
    id: `${name}@personal`,
    name,
    marketplace: "personal",
    installed: true,
    restorable: false,
    orphaned: false,
    installedMeta: {
      id: `${name}@personal`,
      name,
      marketplace: "personal",
      enabled: true,
      scope: "user",
      updateStatus: "update-available",
    },
  };
});
const uiItem: StorePluginItem = {
  ...items[0]!,
  listing: {
    displayName: "Panel",
    category: "utilities",
    heroImage: "https://example.com/panel.png",
  },
  info: {
    id: items[0]!.id,
    name: items[0]!.name,
    marketplace: "personal",
    enabled: !params.has("paused"),
    source: "directory",
    rootPath: "/workspace/plugin",
    skillCount: 0,
    skillRootCount: 0,
    commandRootCount: 0,
    mcpServerNames: ["panel"],
    declaredMcpServerNames: ["panel"],
    uiSurfaces: [
      {
        pluginId: items[0]!.id,
        pluginName: "Panel",
        id: "panel",
        title: "Panel",
        server: "panel",
        resourceUri: "ui://panel/app",
        availability: "session",
      },
    ],
  },
};
function Fixture() {
  const [updated, setUpdated] = useState("");
  const [opened, setOpened] = useState("");
  const [uiOpened, setUiOpened] = useState("");
  const [detailOpen, setDetailOpen] = useState(params.has("detail"));
  const openDetail = (id: string) => {
    setOpened(id);
    if (params.has("ui")) setDetailOpen(true);
  };
  return (
    <StoreContext.Provider value={store}>
      <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
        <TooltipProvider>
          <main className="@container/plugin-store min-h-screen bg-background p-4 text-foreground">
            {detailOpen ? (
              <PluginStoreDetailView
                item={uiItem}
                actions={{
                  onOpenDetail: openDetail,
                  // mainNav=1 模拟主导航市场：不提供打开 UI，只有会话右侧市场才有「打开」。
                  onOpenUi: params.has("mainNav")
                    ? undefined
                    : (item) => {
                        setUiOpened(item.id);
                        setOpened(item.id);
                      },
                  onUpdate: setUpdated,
                  onInstall: () => {},
                  onUninstall: () => {},
                  onSetEnabled: () => {},
                  activeOperations: [],
                  togglingPluginId: null,
                }}
                onRetryDescribe={() => {}}
                onUsePrompt={() => {}}
              />
            ) : (
              <PluginStoreListView
                items={params.has("ui") ? [uiItem] : items}
                marketplaces={[]}
                loading={false}
                query=""
                onQueryChange={() => {}}
                segment="personal"
                onSegmentChange={() => {}}
                actions={{
                  onOpenDetail: openDetail,
                  // mainNav=1 模拟主导航市场：不提供打开 UI，只有会话右侧市场才有「打开」。
                  onOpenUi: params.has("mainNav")
                    ? undefined
                    : (item) => {
                        setUiOpened(item.id);
                        setOpened(item.id);
                      },
                  onUpdate: setUpdated,
                  onInstall: () => {},
                  onUninstall: () => {},
                  onSetEnabled: () => {},
                  activeOperations: [],
                  togglingPluginId: null,
                }}
              />
            )}
            <output data-testid="updated">{updated}</output>
            <output data-testid="opened">{opened}</output>
            <output data-testid="ui-opened">{uiOpened}</output>
          </main>
        </TooltipProvider>
      </ZCodeIntlProvider>
    </StoreContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
