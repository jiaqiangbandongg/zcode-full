import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import { AnimatedSidePanePanel } from "@/app-shell/AnimatedSidePanePanel.js";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { PluginUiWorkspaceProvider, openPluginUiSidePane } from "@/plugin-ui/index.js";
import type { OpenPluginUiSideTabRequest } from "@/plugin-ui/contract.js";
import type { WorkspaceSidePaneState } from "@/lib/workspaceSidePane.js";
import type { PanelImperativeHandle } from "react-resizable-panels";
import "@/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.add(`theme-zai-${params.get("theme") ?? "light"}`);
const workspacePath = "/workspace/example";
const workspaceIdentity = "fixture-workspace";
const remoteSessionId = "fixture-remote-session";
const noop = () => {};
const services = (params.has("noBridge")
  ? {}
  : {
      pluginUiBridgeService: {
        listSurfaces: async (scope: unknown) => {
          const response = await fetch("/surfaces", {
            method: "POST",
            body: JSON.stringify(scope),
          });
          return response.json();
        },
      },
    }) as unknown as IServiceAccessor;
const existingTab: WorkspaceSidePaneState = {
  activeTabId: "whiteboard:fixture",
  tabs: [
    {
      id: "whiteboard:fixture",
      type: "whiteboard",
      boardId: "fixture",
      title: "Existing",
      ownerTaskId: "session-fixture",
    },
  ],
};

function Fixture() {
  const [hasTab, setHasTab] = useState(params.has("existing"));
  const [request, setRequest] = useState<OpenPluginUiSideTabRequest | null>(null);
  const [opened, setOpened] = useState<WorkspaceSidePaneState | null>(null);
  const panelRef = useRef<PanelImperativeHandle | null>(null);
  const panelElementRef = useRef<HTMLDivElement | null>(null);
  // 本测试在 tab owner 边界验收命令与去重；沙箱/Agent 不属于菜单交互回归。
  const open = (next: OpenPluginUiSideTabRequest) => {
    setRequest(next);
    setOpened((current) =>
      openPluginUiSidePane(current, { ...next, workspaceKey: workspaceIdentity }),
    );
  };
  const panel = (
    <AnimatedSidePanePanel
      services={services}
      isVisible
      isDesktop={!params.has("mobile")}
      mobileOverlay={params.has("mobile")}
      sidePaneState={hasTab ? existingTab : null}
      recentClosedSidePaneTabs={[]}
      isBrowserOpen={false}
      supportsEmbeddedBrowser={false}
      workspaceAbsPath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      workspaceRemoteSessionId={remoteSessionId}
      activeTaskId={params.has("draft") ? null : "session-fixture"}
      sidePaneOwnerId="session-fixture"
      gitState={{} as Parameters<typeof AnimatedSidePanePanel>[0]["gitState"]}
      activeGitSourceId="unstaged"
      panelRef={panelRef}
      panelElementRef={panelElementRef}
      browserNavigationRequest={null}
      browserRestoreUrls={{}}
      fileChangeFindActiveIndex={0}
      fileChangeFindNavigationRequestId={0}
      fileChangeFindQuery=""
      onFileChangeFindMatchCountChange={noop}
      onCloseCodeViewer={noop}
      onCloseGit={noop}
      onActivateTab={noop}
      onReorderTab={noop}
      onCloseTab={noop}
      onCloseOtherTabs={noop}
      onCloseAllTabs={noop}
      onReopenClosedTab={noop}
      onOpenBrowserTab={noop}
      onOpenWhiteboard={noop}
      onOpenDeveloperTools={noop}
      onOpenTerminalTab={noop}
      onOpenReviewTab={noop}
      onOpenSelectionSideConversation={noop}
      onOpenBrowserUrl={noop}
      onOpenCodeViewer={noop}
      onOpenSubagentSession={noop}
      onRefreshGit={noop}
      onBrowserNavigationRequestHandled={noop}
      onBrowserUrlChange={noop}
      onBrowserPageMetadataChange={noop}
      onSelectGitSource={noop}
    />
  );
  return (
    <main className="h-screen min-w-0 bg-background text-foreground">
      <button data-testid="show-tabs" onClick={() => setHasTab(true)}>
        Show existing tab
      </button>
      <output data-testid="request" hidden>
        {JSON.stringify(request)}
      </output>
      <output data-testid="opened" hidden>
        {JSON.stringify(opened)}
      </output>
      <div className="h-5/6 min-w-0">
        {params.has("mobile") ? (
          renderPanel()
        ) : (
          <ResizablePanelGroup layoutId="plugin-menu-fixture" orientation="horizontal">
            <ResizablePanel defaultSize={40}>
              <div />
            </ResizablePanel>
            {renderPanel()}
          </ResizablePanelGroup>
        )}
      </div>
    </main>
  );
  function renderPanel() {
    return params.has("noHost") ? (
      panel
    ) : (
      <PluginUiWorkspaceProvider onOpenSidePane={open}>{panel}</PluginUiWorkspaceProvider>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
      <TooltipProvider>
        <Fixture />
      </TooltipProvider>
    </ZCodeIntlProvider>
  </ServiceProvider>,
);
