import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { MentionPlugin } from "@/mentions/MentionPlugin.js";
import { PromptMentionNode } from "@/mentions/nodes/PromptMentionNode.js";
import { ChatPromptActionMenu } from "@/prompt-editor/ChatPromptActionMenu.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { StoreContext } from "@/store/StoreProvider.js";
import { createZCodeStore } from "@/store/index.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import type { IBroadcastService, IServiceAccessor } from "@zcode/services";
import "@/styles.css";
const params = new URLSearchParams(location.search);
const store = createZCodeStore({
  send: async () => {},
  onMessage: () => ({ dispose() {} }),
} as unknown as IBroadcastService);
store.getState().setInterfaceMode("coding");
store.getState().setTheme(params.get("theme") === "light" ? "light" : "dark");
const services = {
  pluginManagementService: {
    getPluginReferenceCatalog: async (params: unknown) => {
      const response = await fetch("/catalog", { method: "POST", body: JSON.stringify(params) });
      if (!response.ok) throw new Error("catalog unavailable");
      return response.json();
    },
  },
  zcodeAgentService: { onAgentRuntimeRestarted: () => ({ dispose() {} }) },
  clientConfigService: {
    getSnapshot: async () => {
      const response = await fetch("/order");
      if (!response.ok) throw new Error("config unavailable");
      return { pluginStoreOrder: await response.json() };
    },
  },
} as unknown as IServiceAccessor;
function Fixture() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [sessionId, setSessionId] = useState<string | null>("frozen-session");
  const [selected, setSelected] = useState("");
  const input = useRef({
    getText: () => "",
    focus: () => document.querySelector<HTMLElement>('[data-testid="editor"]')?.focus(),
    getEditorState: () => undefined,
    insertMention: (item: { value: string }) => setSelected(item.value),
  } as unknown as LexicalChatInputHandle);
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <button data-testid="code" onClick={() => store.getState().setInterfaceMode("coding")}>
        Code
      </button>
      <button data-testid="work" onClick={() => store.getState().setInterfaceMode("general")}>
        Work
      </button>
      <button data-testid="draft" onClick={() => setSessionId(null)}>
        Draft
      </button>
      <output data-testid="selected">{selected}</output>
      <div ref={setContainer} className="mt-80 w-full">
        <LexicalComposer
          initialConfig={{
            namespace: "picker-order",
            nodes: [PromptMentionNode],
            onError: (error) => {
              throw error;
            },
          }}
        >
          <PlainTextPlugin
            contentEditable={
              <ContentEditable data-testid="editor" className="min-h-12 border p-2" />
            }
            placeholder={null}
            ErrorBoundary={LexicalErrorBoundary}
          />
          <MentionPlugin
            workspacePath="/fixture"
            workspaceIdentity="ssh:fixture"
            sessionId={sessionId}
            provider="zcode"
            container={container}
          />
        </LexicalComposer>
        <ChatPromptActionMenu
          actionMenuTitle="Add"
          workspacePath="/fixture"
          workspaceIdentity="ssh:fixture"
          sessionId={sessionId}
          inputApiRef={input}
          container={container}
          showPlugins
        />
      </div>
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
