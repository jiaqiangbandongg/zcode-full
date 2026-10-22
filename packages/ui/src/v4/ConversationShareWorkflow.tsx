import { ToolPresentation } from "@/ToolCallBlocks/ToolPresentation.js";
import { useMemo, type ComponentType } from "react";
import type { ToolCallDisplay, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import type { Theme } from "@/useTheme.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { CreateWorkflowToolCallBlock } from "@/ToolCallBlocks/renderers/create-workflow.js";
import { GetWorkflowRunToolCallBlock } from "@/ToolCallBlocks/renderers/get-workflow-run.js";
import { ListWorkflowRunsToolCallBlock } from "@/ToolCallBlocks/renderers/list-workflow-runs.js";
import { EvalWorkflowSnippetToolCallBlock } from "@/ToolCallBlocks/renderers/eval-workflow-snippet.js";
import { ListSavedWorkflowsPresentation } from "@/ToolCallBlocks/renderers/list-saved-workflows-presentation.js";
import { ResumeWorkflowRunToolCallBlock } from "@/ToolCallBlocks/renderers/resume-workflow-run.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const RENDERERS: Partial<
  Record<ToolCallDisplay["kind"], ComponentType<ToolCallBlockRenderContext>>
> = {
  create_workflow: CreateWorkflowToolCallBlock,
  get_workflow_run: GetWorkflowRunToolCallBlock,
  list_workflow_runs: ListWorkflowRunsToolCallBlock,
  eval_workflow_snippet: EvalWorkflowSnippetToolCallBlock,
  saved_workflow_list: ListSavedWorkflowsPresentation,
  resume_workflow_run: ResumeWorkflowRunToolCallBlock,
};

export function hasConversationShareWorkflowDisplay(row: ToolCallRow): boolean {
  return row.display !== undefined && Object.hasOwn(RENDERERS, row.display.kind);
}

export function ConversationShareWorkflow({ row, theme }: { row: ToolCallRow; theme: Theme }) {
  const { intl } = useZCodeIntl();
  const context = useMemo<ToolCallBlockRenderContext>(
    () => ({
      nestedToolRenderer: ToolPresentation,
      toolCallNode: toolCallRowToLegacyNode(row),
      // 匿名分享没有 workspace/session authority；只复用展示，绝不注入文件、运行或恢复回调。
      workspacePath: "",
      theme,
      displayModel: {
        inlinePreview: { type: "none" },
        planResult: null,
        viewerSource: null,
        viewerLabelId: "codeViewer.viewCode",
        showSummaryFileLink: false,
        showInput: false,
        showOutput: false,
        showKind: false,
      },
      viewerSource: null,
      rawFileSummaries: [],
      isRunning: false,
      statusLabel: "",
      childToolList: null,
      disableSummaryContentAnimation: true,
    }),
    [row, theme],
  );
  const Renderer = row.display === undefined ? undefined : RENDERERS[row.display.kind];
  if (Renderer === undefined) return null;
  return (
    <div className="min-w-0 max-w-full" data-conversation-share-workflow={row.display?.kind}>
      <p className="mb-1 text-ui-xs text-foreground-subtlest">
        {intl.formatMessage({ id: "conversationShare.workflowSnapshot" })}
      </p>
      <Renderer {...context} />
    </div>
  );
}
