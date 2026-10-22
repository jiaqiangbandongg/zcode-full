import { Library } from "lucide-react";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import { ListSavedWorkflowsPresentation } from "@/ToolCallBlocks/renderers/list-saved-workflows-presentation.js";
export { readListSavedWorkflowsResult } from "@/ToolCallBlocks/renderers/list-saved-workflows-presentation.js";

const ICON = <Library className="size-4 shrink-0 text-foreground-subtle" />;

// 桌面 fallback 依赖宿主服务，分享页只引用纯展示组件。
export function ListSavedWorkflowsToolCallBlock(context: ToolCallBlockRenderContext) {
  return (
    <ListSavedWorkflowsPresentation
      {...context}
      fallback={<FallbackToolCallBlock {...context} iconOverride={ICON} />}
    />
  );
}
