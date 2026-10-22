import { useMemo } from "react";
import { GlobeIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

// 内联 JSX 会让 memo 化的 ToolLayout 每次收到新引用；图标复用，标题仅在 URL 改变时重建。
const WEB_FETCH_ICON = <GlobeIcon className="size-4 shrink-0" />;

export function getWebFetchPrimaryText(input: unknown): string {
  // 抓取目标与提取要求是不同事实；prompt 不能替代 URL，否则分享与审批会隐藏目标地址。
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const url = (input as Record<string, unknown>).url;
  return typeof url === "string" ? url.trim() : "";
}

export function WebFetchToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const url = getWebFetchPrimaryText(toolCall.input);
  const primaryText = useMemo(() => <span className="min-w-0 truncate">{url}</span>, [url]);
  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={WEB_FETCH_ICON}
      showIcon={context.showIcon !== false}
      canToggle={false}
      kindLabel={
        context.kindLabelOverride ??
        intl.formatMessage({
          id: context.isRunning ? "chat.toolCall.webFetch.fetching" : "chat.toolCall.kind.webFetch",
        })
      }
      primaryText={primaryText}
      statusLabel={context.statusLabel}
      showFailureStatus={toolCall.status === "failed"}
      statusTooltip={toolCall.status === "failed" ? context.errorText : undefined}
      isRunning={context.isRunning}
      title={url || undefined}
      content={null}
    />
  );
}
