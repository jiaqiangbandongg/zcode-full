import { createRoot } from "react-dom/client";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
const locale = params.get("locale") === "en-US" ? "en-US" : "zh-CN";
document.documentElement.className = `theme-zai-${theme}`;
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={locale}>
    <TooltipProvider>
      <div className="flex h-screen w-64 max-w-full flex-col justify-end bg-sidebar">
        <WorkspaceSidebarFooter
          theme={theme}
          localeMenuValue={locale}
          onLocaleChange={() => {}}
          onThemeChange={() => {}}
          onLogout={() => {}}
          isDesktop={params.get("mobile") !== "1"}
          user={
            params.get("guest") === "1"
              ? null
              : {
                  id: params.get("id") ?? "12345678901234567890",
                  username: "Alex",
                  displayName: "Alex",
                }
          }
        />
      </div>
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
