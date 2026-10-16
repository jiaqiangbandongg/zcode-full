import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { McpToolCallBlock } from "@/ToolCallBlocks/renderers/mcp.js";
import { usePluginUiToolCallModel } from "@/plugin-ui/adapters/usePluginUiToolCallModel.js";
import { PluginUiToolCallView } from "@/plugin-ui/components/PluginUiToolCallBlock.js";
import { readPluginUiPresentation } from "@/plugin-ui/domain/readPluginUiPresentation.js";

/** 宿主工具行渲染插槽，普通 MCP 卡片作为模块外的展示依赖注入。 */
export function PluginUiToolCallBlock(context: ToolCallBlockRenderContext) {
  const model = usePluginUiToolCallModel(context);
  return <PluginUiToolCallView {...model} fallback={<McpToolCallBlock {...context} />} />;
}
export function shouldRenderPluginUi(
  context: Pick<ToolCallBlockRenderContext, "toolCallNode" | "pluginUi">,
): boolean {
  return Boolean(
    context.pluginUi?.scope.sessionId &&
    readPluginUiPresentation(context.toolCallNode.toolCall.raw),
  );
}
