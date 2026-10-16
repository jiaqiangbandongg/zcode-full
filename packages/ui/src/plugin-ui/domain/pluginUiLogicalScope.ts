import type { PluginUiScopeRef } from "@zcode/shared/mcp-apps";
import type { PluginUiPresentation } from "../contract.js";

/** 只有显式共享身份可合并；权限声明不同的普通 widget 不共用页面。 */
export function resolvePluginUiLogicalScope(
  presentation: Pick<PluginUiPresentation, "surface" | "widgetMeta" | "csp">,
  fallback: PluginUiScopeRef,
): PluginUiScopeRef {
  if (presentation.surface) return { kind: "surface", surfaceId: presentation.surface };
  if (fallback.kind === "surface" || !presentation.widgetMeta) return fallback;
  try {
    const widget = JSON.parse(presentation.widgetMeta)["openai/widgetSessionId"];
    if (typeof widget !== "string" || !widget) return fallback;
    const permissions = Object.entries(presentation.csp ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, domains]) => [name, [...domains].sort()]);
    return { kind: "toolCall", toolCallId: `widget:${JSON.stringify([widget, permissions])}` };
  } catch {
    return fallback;
  }
}
