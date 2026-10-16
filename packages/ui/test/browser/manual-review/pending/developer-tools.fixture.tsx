import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DeveloperToolsPane } from "@/DeveloperToolsPane.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { IServiceAccessor } from "@zcode/services";
import "@/styles.css";
const params = new URLSearchParams(location.search);
document.documentElement.classList.add(
  params.get("theme") === "light" ? "theme-zai-light" : "theme-zai-dark",
);
const services = {
  zcodeAgentService: {
    readSessionDebug: async (target: unknown) => {
      const response = await fetch("/debug", { method: "POST", body: JSON.stringify(target) });
      if (!response.ok) throw new Error("debug failed");
      return response.json();
    },
  },
} as unknown as IServiceAccessor;
function Fixture() {
  const [taskId, setTaskId] = useState("session-1");
  const [enabled, setEnabled] = useState(true);
  return (
    <main className="h-screen min-w-0 bg-background text-foreground">
      <button onClick={() => setTaskId("empty")}>Switch task</button>
      <button onClick={() => setEnabled(!enabled)}>Toggle visibility</button>
      <div className="h-5/6 min-w-0">
        <DeveloperToolsPane
          workspacePath="/debug"
          workspaceIdentity="ssh:debug"
          taskId={taskId}
          enabled={enabled}
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <ZCodeIntlProvider initialLocale={params.get("locale") === "en-US" ? "en-US" : "zh-CN"}>
      <Fixture />
    </ZCodeIntlProvider>
  </ServiceProvider>,
);
