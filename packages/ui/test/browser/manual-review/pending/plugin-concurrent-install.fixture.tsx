import { createRoot } from "react-dom/client";
import type { IPluginManagementService } from "@zcode/services";
import { createPluginManagementStore } from "@/store/pluginManagementStore.js";
import { PluginStoreInstallButton } from "@/settings/PluginStoreCard.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";
const releases = new Map<string, () => void>();
const service = {
  listPlugins: async () => ({ plugins: [], diagnostics: [] }),
  getPluginsOverview: async () => ({
    marketplaces: [],
    availablePlugins: [],
    installedPlugins: [],
    restorableBuiltins: [],
    diagnostics: [],
  }),
  installPlugin: ({ pluginName }: { pluginName: string }) =>
    new Promise((resolve) => {
      releases.set(pluginName, () =>
        resolve({ installedPlugins: [], dependencyClosure: [], diagnostics: [] }),
      );
    }),
} as unknown as IPluginManagementService;
const store = createPluginManagementStore(service);
await store.getState().initialize({ workspacePath: "/workspace/fixture", pluginService: service });
store.subscribe((state) => logger.debug("install-state", JSON.stringify(state.activeOperations)));
function Fixture() {
  const state = store();
  return (
    <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
      <main className="flex flex-col gap-4 bg-background p-4 text-foreground">
        {["first", "second"].map((name) => (
          <div key={name}>
            <span>{name}</span>
            <PluginStoreInstallButton
              item={{
                id: `${name}@personal`,
                name,
                marketplace: "personal",
                installed: false,
                restorable: false,
                orphaned: false,
              }}
              actions={{
                ...state,
                onInstall: () => {
                  void state.installPlugin(name, "personal", service);
                },
                onOpenDetail: () => {},
                onUninstall: () => {},
                onUpdate: () => {},
              }}
            />
            <button data-testid={`finish-${name}`} onClick={() => releases.get(name)?.()}>
              Finish {name}
            </button>
          </div>
        ))}
      </main>
    </ZCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
