import "@/styles.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IPlatformService } from "@zcode/shared";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

const tool: ToolCallRow = {
  rowId: 5,
  turnId: "gate",
  createdAt: 1,
  createdAtSeq: 5,
  kind: "toolCall",
  toolCallId: "tool-5",
  toolName: "CreateWorkflow",
  status: "success",
  input: { name: "Gate workflow", script: "return;" },
  inputText: "{}",
};
function Fixture() {
  const [joined, setJoined] = useState(false);
  const [running, setRunning] = useState(true);
  const unit: ConversationTurnRenderUnit = {
    key: "gate",
    turnId: "gate",
    visibleUserInputs: [],
    assistantWorkRows: [tool],
    assistantHistoryRows: [],
    assistantFollowingRows: [],
    assistantTailRows: [],
    browserTurnEndRows: [],
    hookInvocations: [],
    assistantTextRows: [],
    leadingBoundaryRows: [],
    flowItems: [],
    renderRows: [tool],
    isLastTurn: true,
    isRunning: running,
    assistantHistoryDefaultOpen: false,
    timelineOnly: false,
  };
  return (
    <ZCodeIntlProvider initialLocale="en-US">
      <PlatformProvider platform={{} as IPlatformService}>
        <TooltipProvider>
          <button onClick={() => setJoined(true)}>Join run</button>
          <button onClick={() => setRunning(false)}>Finish reply</button>
          <ConversationTurnGroup
            unit={unit}
            context={{
              workspacePath: "/workspace",
              theme: "system",
              codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
              workflowRunByToolCallId: joined
                ? new Map([
                    [
                      "tool-5",
                      { runId: "run-gate", status: "running", nodesTotal: 1, nodesSettled: 0 },
                    ],
                  ])
                : undefined,
            }}
          />
        </TooltipProvider>
      </PlatformProvider>
    </ZCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
