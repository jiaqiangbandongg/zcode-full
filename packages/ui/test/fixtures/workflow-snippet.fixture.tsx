import "@/styles.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { EvalWorkflowSnippetToolCallBlock } from "@/ToolCallBlocks/renderers/eval-workflow-snippet.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
function Fixture() {
  const [state, setState] = useState("running");
  const [startedAt] = useState(Date.now);
  const display =
    state === "running"
      ? undefined
      : {
          kind: "eval_workflow_snippet",
          ok: state === "completed",
          durationMs: 427,
          diagnostics: [],
          logs: ["read 2 files"],
          response:
            state === "completed"
              ? 'The snippet completed in 427ms.\nReturn value:\n["package.json", "script.mjs"]\n\nLogs:\n- read 2 files'
              : "The snippet failed (TIMEOUT): deadline exceeded\n\nLogs:\n- read 2 files",
        };
  const context = {
    toolCallNode: {
      toolCall: {
        toolId: "snippet-smoke",
        kind: "EvalWorkflowSnippet",
        status: state === "failed" ? "failed" : state,
        startedAt,
        input: { code: 'return await files.glob("*.json");' },
        raw: { display },
      },
      childToolCalls: [],
    },
    isRunning: state === "running",
    forceOpen: false,
    canToggle: true,
  } as unknown as ToolCallBlockRenderContext;
  return (
    <ZCodeIntlProvider initialLocale="en-US">
      <TooltipProvider>
        <button data-testid="complete" onClick={() => setState("completed")}>
          Complete
        </button>
        <button data-testid="fail" onClick={() => setState("failed")}>
          Fail
        </button>
        <EvalWorkflowSnippetToolCallBlock {...context} />
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
