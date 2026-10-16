import { PluginUiCard } from "@/plugin-ui/components/PluginUiCard.js";
import type { PluginUiSidePaneViewProps } from "@/plugin-ui/contract.js";

/** 纯侧栏视图：不读取会话、lease、projection 或 workspace store。 */
export function PluginUiSidePaneView({
  scopeRef,
  host,
  loadingLabel,
  errorLabel,
  retryLabel,
  onWidthChange,
}: PluginUiSidePaneViewProps) {
  return (
    <div
      {...(scopeRef.kind === "toolCall"
        ? { "data-plugin-ui-tool-call-id": scopeRef.toolCallId }
        : { "data-plugin-ui-surface-id": scopeRef.surfaceId })}
      className="h-full min-h-0 overflow-hidden bg-background"
    >
      <PluginUiCard
        pageKey={host.pageKey}
        fill
        handle={host.handle}
        phase={host.phase}
        height={host.height}
        prefersBorder={false}
        error={host.error}
        loadingLabel={loadingLabel}
        errorLabel={errorLabel}
        retryLabel={retryLabel}
        onRetry={host.reload}
        onWidthChange={onWidthChange}
      />
    </div>
  );
}
