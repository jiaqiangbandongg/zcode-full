import "@/styles.css";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { WorkflowArtifactPill } from "@/components/workflow-timeline/WorkflowArtifactPill.js";
import { WorkflowNotificationToolRow } from "@/v4/WorkflowNotificationToolRow.js";
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <TooltipProvider>
      <WorkflowArtifactPill
        artifact={{ id: "sample", kind: "markdown", title: "Sample" }}
        testId="sample-artifact"
      />
      <WorkflowNotificationToolRow
        notification={{
          kind: "terminal",
          status: "completed",
          summary: "done",
          result: JSON.stringify(
            Array.from({ length: 40 }, (_, i) => ({ step: i, status: "done" })),
          ),
          resultForm: "json",
          artifacts: [{ id: "doc", kind: "markdown", title: "Desktop startup" }],
        }}
        runName="Desktop workflow"
        testIdKey="link"
        theme="system"
        onOpenArtifact={() => {
          document.body.dataset.open = "true";
        }}
      />
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
