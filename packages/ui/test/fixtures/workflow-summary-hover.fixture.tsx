import "@/styles.css";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { WorkflowToolSummary } from "@/v4/WorkflowToolSummary.js";
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <TooltipProvider>
      <WorkflowToolSummary
        toolCallId="hover"
        summary={{ runId: "hover", nodesTotal: 3, nodesSettled: 0, status: "running" }}
        onOpen={() => {
          document.body.dataset.open = "true";
        }}
      />
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
