import { useMemo, type ComponentProps } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { mapToolStatus } from "@/lib/mapToolStatus.js";
import { buildToolDisplayModel } from "@/lib/toolDisplay.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import {
  getCompactToolCallStatusMessageId,
  isCompactToolCallRunningState,
} from "@/lib/toolCallSummary.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";
import { resolveToolCallRenderer } from "@/ToolCallBlocks/resolveRenderer.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { CuaGroupToolCallBlock } from "@/ToolCallBlocks/renderers/cua-group.js";
import {
  readRawToolCallFileSummaries,
  type ToolCallBlockRenderContext,
} from "@/ToolCallBlocks/shared.js";
import { useToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";

/** 无宿主依赖的工具装配：共享原 renderer；公开页面不构造服务、插件 runtime 或工作区。 */
export function ToolPresentation({
  toolCallNode,
  ...options
}: {
  toolCallNode: TaskChatToolCallTreeNode;
} & Partial<
  Pick<
    ToolCallBlockRenderContext,
    | "theme"
    | "codePreviewSettings"
    | "onOpenBrowserUrl"
    | "authoritativeAgentType"
    | "showTodoToolCalls"
  >
> & {
    cuaGroupEvents?: ComponentProps<typeof CuaGroupToolCallBlock>["events"];
    renderCuaAssistantMessage?: ComponentProps<
      typeof CuaGroupToolCallBlock
    >["renderAssistantMessage"];
    renderCuaReasoning?: ComponentProps<typeof CuaGroupToolCallBlock>["renderReasoning"];
  }) {
  const { intl } = useZCodeIntl();
  const capabilities = useToolPresentationCapabilities();
  const { childToolCalls } = toolCallNode;
  const normalizedNode = useMemo(() => {
    if (!capabilities.normalizeOutputText || typeof toolCallNode.toolCall.output !== "string")
      return toolCallNode;
    const output = capabilities.normalizeOutputText(toolCallNode.toolCall.output);
    const raw = toolCallNode.toolCall.raw as Record<string, unknown> | undefined;
    return {
      ...toolCallNode,
      toolCall: { ...toolCallNode.toolCall, output, raw: { ...raw, rawOutput: output } },
    };
  }, [capabilities.normalizeOutputText, toolCallNode]);
  const { toolCall } = normalizedNode;
  const state = mapToolStatus(toolCall.status);
  const displayModel = useMemo(() => buildToolDisplayModel(toolCall, ""), [toolCall]);
  const context: ToolCallBlockRenderContext = {
    nestedToolRenderer: ToolPresentation,
    ...options,
    toolCallNode: normalizedNode,
    workspacePath: "",
    isOfficeMode: false,
    displayModel,
    viewerSource: displayModel.viewerSource,
    rawFileSummaries: readRawToolCallFileSummaries(toolCall.raw, toolCall),
    isRunning: isCompactToolCallRunningState(state),
    statusLabel: intl.formatMessage({
      id: getCompactToolCallStatusMessageId(state, toolCall.status),
    }),
    errorText: getToolCallErrorText(toolCall),
    disableSummaryContentAnimation: true,
    childToolList: childToolCalls.length ? (
      <div className="ml-2 space-y-2 border-l border-border pl-3.5">
        {childToolCalls.map((child) => (
          <ToolPresentation key={child.toolCall.toolId} toolCallNode={child} {...options} />
        ))}
      </div>
    ) : null,
  };
  const identity = resolveToolCallIdentity(toolCall);
  if (identity.family === "todo" && options.showTodoToolCalls !== true) return null;
  const Renderer = resolveToolCallRenderer(context);
  if (Renderer === FallbackToolCallBlock)
    return <FallbackToolCallBlock {...context} hideRawFallback={capabilities.readonly} />;
  if (Renderer === CuaGroupToolCallBlock)
    return (
      <CuaGroupToolCallBlock
        {...context}
        events={options.cuaGroupEvents}
        renderAssistantMessage={options.renderCuaAssistantMessage}
        renderReasoning={options.renderCuaReasoning}
      />
    );
  return <Renderer {...context} />;
}
