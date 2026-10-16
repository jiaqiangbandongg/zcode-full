import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { MentionPlugin } from "@/mentions/MentionPlugin.js";
import { PromptMentionNode } from "@/mentions/nodes/PromptMentionNode.js";
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
  fileService: {
    searchWorkspaceFiles: async (params: unknown) => {
      const response = await fetch("/search-files", {
        method: "POST",
        body: JSON.stringify(params),
      });
      if (!response.ok) throw new Error("search unavailable");
      return response.json();
    },
  },
} as unknown as IServiceAccessor;
function Fixture() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <main className="min-h-screen bg-background p-4 text-foreground">
      <div ref={setContainer} className="mt-40 w-full">
        <LexicalComposer
          initialConfig={{
            namespace: "file-mention-host",
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
            workspacePath={params.get("workspace")!}
            workspaceIdentity="ssh:test-host"
            provider="zcode"
            container={container}
          />
        </LexicalComposer>
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
