import { useCallback, useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "../../../ui/src/i18n/IntlProvider.js";
import { TabStoreProvider } from "../../../ui/src/store/TabStoreProvider.js";
import { ConversationTimeline } from "../../../ui/src/v4/ConversationTimeline.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "../../../ui/src/lib/codePreviewSettings.js";
import {
  PluginUiSessionProvider,
  PluginUiWorkspaceProvider,
  PluginUiSidePane,
  buildPluginUiSidePaneTabId,
} from "../../../ui/src/plugin-ui/index.js";
import { setPluginUiManualPin } from "../../../ui/src/plugin-ui/app/pluginUiDisclosureStore.js";
import {
  pluginUiPages,
  subscribePage,
} from "../../../ui/src/plugin-ui/adapters/pluginUiPageRegistry.js";
import { buildPluginUiSurfaceKey } from "../../../ui/src/plugin-ui/contract.js";

export interface RowCase {
  id: number;
  status?: ToolCallRow["status"];
  isError?: boolean;
  fullscreen?: boolean;
  widget?: boolean;
}
const layout = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

/** 使用真实时间线和工具行，不直接挂 PluginUiCard；避免绕过展示资格/替代/折叠策略。 */
export function RowsFixture({ config, ready }: { config: any; ready: () => void }) {
  const [cases, setCases] = useState<RowCase[]>([]);
  const [mounted, setMounted] = useState(true);
  const [tab, setTab] = useState<any>(null);
  const [opens, setOpens] = useState(0);
  const open = useCallback((request: any) => {
    setOpens((n) => n + 1);
    setTab({ ...request, id: buildPluginUiSidePaneTabId(request), type: "plugin-ui" });
  }, []);
  const rows = useMemo<ToolCallRow[]>(
    () =>
      cases.map((c) => ({
        kind: "toolCall",
        rowId: c.id,
        turnId: "fixture-turn",
        createdAt: c.id,
        createdAtSeq: c.id,
        toolCallId: `row-${c.id}`,
        toolName: "mcp__fixture__edit",
        status: c.status ?? "success",
        inputText: JSON.stringify({ sequence: c.id }),
        output: { text: c.isError ? `fixture-error-${c.id}` : `fixture-success-${c.id}` },
        ...(c.status === "error"
          ? { error: { code: "fixture", message: `transport-error-${c.id}` } }
          : {}),
        display: {
          kind: "mcp_tool",
          serverName: config.presentation.serverName,
          toolName: "edit",
          ui: {
            pluginId: config.presentation.pluginId,
            resourceUri: config.presentation.resourceUri,
            ...(c.widget
              ? { widgetMeta: JSON.stringify({ "openai/widgetSessionId": "same" }) }
              : { surface: "same" }),
            ...(c.isError ? { isError: true } : {}),
            preferredDisplayMode: c.fullscreen ? "fullscreen" : "inline",
            showInline: true,
            structuredContent: JSON.stringify({ sequence: c.id }),
          },
        },
      })),
    [cases, config],
  );
  const rowContext = useMemo(
    () => ({
      ...config.scope,
      theme: "light" as const,
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
    }),
    [config],
  );
  useEffect(() => {
    (window as any).setRows = async (next: RowCase[], pin = false) => {
      if (pin)
        for (const c of next) setPluginUiManualPin(config.scope.sessionId, `row-${c.id}`, true);
      flushSync(() => setCases(next));
      await layout();
    };
    (window as any).mountRows = async (value: boolean) => {
      flushSync(() => setMounted(value));
      await layout();
    };
    (window as any).rowsState = () => ({
      cards: document.querySelectorAll('[data-tool-call-id] [data-testid="plugin-ui-card"]').length,
      placeholders: document.querySelectorAll('[data-testid="plugin-ui-side-pane-placeholder"]')
        .length,
      opens,
      sidebar: tab !== null,
      views: document.querySelectorAll("webview").length,
      owners: [
        ...document.querySelectorAll(
          '[data-tool-call-id] [data-testid="plugin-ui-card"], [data-testid="plugin-ui-side-pane-placeholder"]',
        ),
      ].map((e) => e.closest("[data-tool-call-id]")?.getAttribute("data-tool-call-id")),
    });
    (window as any).waitRowsRunning = () =>
      new Promise<void>((resolve, reject) => {
        const key = buildPluginUiSurfaceKey(
          { ...config.scope, ...config.presentation },
          config.scope.scope,
        );
        let off = () => {};
        const check = () => {
          const snapshot = pluginUiPages.get(key)?.snapshot();
          if (snapshot?.phase === "running") {
            off();
            resolve();
          }
          if (snapshot?.phase === "error") {
            off();
            reject(new Error(snapshot.error ?? "page failed"));
          }
        };
        off = subscribePage(key, check);
        check();
      });
    (window as any).rowPageVisible = () =>
      pluginUiPages.get(
        buildPluginUiSurfaceKey({ ...config.scope, ...config.presentation }, config.scope.scope),
      )?.visible === true;
    ready();
  }, [config, opens, tab, ready]);
  return (
    <ZCodeIntlProvider initialLocale="en-US">
      <TabStoreProvider>
        <PluginUiWorkspaceProvider onOpenSidePane={open}>
          <PluginUiSessionProvider
            {...config.scope}
            readOnly
            sendText={async () => {}}
            uploadAttachment={async () => {
              throw new Error("not used");
            }}
          >
            <div style={{ position: "absolute", left: 10, top: 10, width: 460, height: 650 }}>
              {mounted && (
                <ConversationTimeline
                  rows={rows}
                  totalCount={rows.length}
                  sessionKey={config.scope.sessionId}
                  rowContext={rowContext}
                  hideTurnNavigator
                />
              )}
            </div>
            {tab && (
              <div style={{ position: "absolute", left: 500, top: 10, width: 450, height: 650 }}>
                <button id="close-sidebar" onClick={() => setTab(null)}>
                  Close sidebar
                </button>
                <PluginUiSidePane tab={tab} onCloseTab={() => setTab(null)} />
              </div>
            )}
          </PluginUiSessionProvider>
        </PluginUiWorkspaceProvider>
      </TabStoreProvider>
    </ZCodeIntlProvider>
  );
}
