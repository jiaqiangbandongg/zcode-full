import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PluginStoreListView } from "@/settings/PluginStoreListView.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import "@/styles.css";

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
function Fixture() {
  const [updated, setUpdated] = useState("");
  const [opened, setOpened] = useState("");
  return (
    <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
      <TooltipProvider>
        <main className="min-h-screen bg-background p-4 text-foreground">
          <PluginStoreListView
            items={items}
            marketplaces={[]}
            loading={false}
            query=""
            onQueryChange={() => {}}
            segment="public"
            onSegmentChange={() => {}}
            onOpenManage={() => {}}
            actions={{
              onOpenDetail: setOpened,
              onUpdate: setUpdated,
              onInstall: () => {},
              onUninstall: () => {},
              onSetEnabled: () => {},
              operationId: null,
              togglingPluginId: null,
            }}
          />
          <output data-testid="updated">{updated}</output>
          <output data-testid="opened">{opened}</output>
        </main>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
