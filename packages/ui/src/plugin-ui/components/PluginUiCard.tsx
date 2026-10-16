import { cn } from "@/components/lib/utils.js";
import { TID_PLUGIN_UI_CARD } from "@zcode/shared";
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { useLayoutEffect, useRef } from "react";
import { bindPluginUiPage } from "../adapters/pluginUiPageRegistry.js";
import type { PluginUiHostPhase } from "../app/pluginUiHostController.js";

export interface PluginUiCardProps {
  pageKey: string;
  handle: PluginSandboxHandle | null;
  phase: PluginUiHostPhase;
  height: number;
  prefersBorder: boolean;
  error: string | null;
  /** 侧栏模式撑满容器；内联模式按 height 固定。 */
  fill?: boolean;
  loadingLabel: string;
  errorLabel: string;
  /** 错误态的"重新加载"；缺省不显示按钮。 */
  retryLabel?: string;
  onRetry?: () => void;
  onWidthChange?: (width: number) => void;
}

/** 卡片只注册布局锚点；活 webview 由窗口页面管理器持有。 */
export function PluginUiCard(props: PluginUiCardProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = containerRef.current;
    if (node) return bindPluginUiPage(props.pageKey, node, props.fill === true);
  }, [props.pageKey, props.fill]);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node || !props.onWidthChange || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number") props.onWidthChange?.(width);
    });
    observer.observe(node);
    props.onWidthChange(node.clientWidth);
    return () => observer.disconnect();
  }, [props.onWidthChange]);

  const showError = props.phase === "error";
  return (
    <div
      ref={containerRef}
      data-testid={TID_PLUGIN_UI_CARD}
      data-plugin-ui-phase={props.phase}
      className={cn(
        "relative w-full overflow-hidden",
        props.prefersBorder && "rounded-lg border border-border bg-surface",
        props.fill ? "h-full min-h-0" : "",
      )}
      style={props.fill ? undefined : { height: `${props.height}px` }}
    >
      {showError ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-3 py-2 text-ui-sm text-foreground-subtle">
          <span>{props.error ?? props.errorLabel}</span>
          {props.onRetry && props.retryLabel ? (
            <button
              type="button"
              className="rounded-md border border-border px-2 py-0.5 text-ui-sm text-foreground hover:bg-menu-hover"
              data-testid="plugin-ui-retry"
              onClick={props.onRetry}
            >
              {props.retryLabel}
            </button>
          ) : null}
        </div>
      ) : null}
      {!showError && !props.handle ? (
        <div className="flex h-full items-center justify-center px-3 py-2 text-ui-sm text-foreground-subtle">
          {props.loadingLabel}
        </div>
      ) : null}
    </div>
  );
}
