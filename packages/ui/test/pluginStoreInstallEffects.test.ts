// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { IPluginManagementService } from "@zcode/services";
import { createPluginManagementStore } from "@/store/pluginManagementStore.js";
import type { PluginStoreActions } from "@/settings/PluginStoreCard.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PluginStorePage } from "@/settings/PluginStorePage.js";

let store: ReturnType<typeof createPluginManagementStore>;
let service: IPluginManagementService;
let actions: PluginStoreActions;
const effects = vi.hoisted(() => ({
  invalidate: vi.fn(async () => {}),
  skills: vi.fn(async () => {}),
}));
vi.mock("@/store/pluginManagementStore.js", async (original) => ({
  ...(await original<typeof import("@/store/pluginManagementStore.js")>()),
  useScopedPluginManagementStore: () => store,
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ reportTelemetryEvent: vi.fn() }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ pluginManagementService: service, skillsService: {} }),
}));
vi.mock("@/hooks/usePluginStoreOrder.js", () => ({
  usePluginStoreOrder: () => ({ order: [], refresh: vi.fn() }),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({ useOptionalTabStore: () => undefined }));
vi.mock("@/plugin-ui/index.js", () => ({
  useMarketPluginUi: () => ({ surfaces: [] }),
  resolvePluginUiSurfaceTitle: () => "Panel",
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "en-US",
  }),
}));
vi.mock("@/lib/zcodeDraftSkillInvalidation.js", () => ({
  invalidateDeferredDraftSessionForSkillChange: effects.invalidate,
}));
vi.mock("@/lib/skillStoreRefresh.js", () => ({
  refreshSharedSkillStoreForWorkspace: effects.skills,
}));
vi.mock("@/conversation-workspace-target/PluginAddMenu.js", () => ({ PluginAddMenu: () => null }));
vi.mock("@/settings/PluginStoreListView.js", () => ({
  PluginStoreListView: (props: { actions: PluginStoreActions }) => {
    actions = props.actions;
    return null;
  },
}));
vi.mock("@/settings/PluginUninstallConfirmDialog.js", () => ({
  PluginUninstallConfirmDialog: () => null,
}));
vi.mock("@/settings/PluginStoreSourcesDialog.js", () => ({ PluginStoreSourcesDialog: () => null }));
vi.mock("@/settings/AddMarketplaceSourceDialog.js", () => ({
  AddMarketplaceSourceDialog: () => null,
}));

beforeEach(async () => {
  vi.clearAllMocks();
  service = {
    listPlugins: vi.fn(async () => ({ plugins: [], diagnostics: [] })),
    getPluginsOverview: vi.fn(async () => ({
      marketplaces: [],
      availablePlugins: [],
      installedPlugins: [],
      restorableBuiltins: [],
      diagnostics: [],
    })),
    installPlugin: vi.fn(async () => ({
      installedPlugins: [],
      dependencyClosure: [],
      diagnostics: [],
    })),
    restoreBuiltinPlugin: vi.fn(async () => ({ pluginId: "panel@example", diagnostics: [] })),
  } as unknown as IPluginManagementService;
  store = createPluginManagementStore(service);
  await store.getState().initialize({ workspacePath: "/project/a", pluginService: service });
});

it.each([false, true])(
  "does not refresh capabilities after a failed install or restore (restore=%s)",
  async (restorable) => {
    const diagnostics = [
      { code: "test_failure", message: "installation failed", severity: "error" as const },
    ];
    vi.mocked(service.installPlugin).mockResolvedValue({
      installedPlugins: [],
      dependencyClosure: [],
      diagnostics,
    });
    vi.mocked(service.restoreBuiltinPlugin).mockResolvedValue({
      pluginId: "panel@example",
      diagnostics,
    });
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(PluginStorePage, { workspacePath: "/project/a", embedded: true }),
      ),
    );
    actions.onInstall({
      id: "panel@example",
      name: "panel",
      marketplace: "example",
      restorable,
    } as never);
    await vi.waitFor(() => expect(store.getState().activeOperations).toEqual([]));
    expect(store.getState().error).toBe("installation failed");
    expect(effects.invalidate).not.toHaveBeenCalled();
    expect(effects.skills).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "refreshes capabilities after a successful install or restore (restore=%s)",
  async (restorable) => {
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(PluginStorePage, { workspacePath: "/project/a", embedded: true }),
      ),
    );
    actions.onInstall({
      id: "panel@example",
      name: "panel",
      marketplace: "example",
      restorable,
    } as never);
    await vi.waitFor(() => expect(store.getState().activeOperations).toEqual([]));
    expect(effects.invalidate).toHaveBeenCalledTimes(1);
    expect(effects.skills).toHaveBeenCalledTimes(1);
  },
);
