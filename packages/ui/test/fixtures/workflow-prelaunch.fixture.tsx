import "@/styles.css";
// 浏览器交互回归使用真实组件，隔离模型生成耗时，不接入真实会话或发送审批应答。
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { CreateWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/create-workflow.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip.js";

function Fixture() {
  const [state, setState] = useState("inputStreaming");
  const context = {
    toolCallNode: {
      toolCall: {
        toolId: "prelaunch-smoke",
        kind: "CreateWorkflow",
        title: "CreateWorkflow",
        status: "running",
        raw: { v4Status: state },
        input: {
          name: "Smoke workflow",
          script: Array.from(
            { length: 50 },
            (_, i) => `const planner${i} = agent("planner${i}");`,
          ).join("\n"),
        },
      },
      childToolCalls: [],
    },
    isRunning: true,
    forceOpen: state === "inputStreaming",
    canToggle: true,
  } as unknown as ToolCallBlockRenderContext;
  return (
    <ZCodeIntlProvider initialLocale="en-US">
      <TooltipProvider>
        <button data-testid="advance-state" onClick={() => setState("pendingApproval")}>
          Await confirmation
        </button>
        <CreateWorkflowToolCallBlock {...context} />
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
