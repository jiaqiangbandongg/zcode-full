import type { McpAppsStyleVariables } from "@zcode/shared/mcp-apps";
import { buildPluginUiStyleVariables } from "../domain/pluginUiStyleVariables.js";

/**
 * 从宿主根元素读主题 token 的计算值（`.dark` / zai 主题类切换后随之变化），
 * 非 DOM 环境（单测、SSR）全部落到兜底值。
 */
export function readPluginUiStyleVariables(): McpAppsStyleVariables {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return buildPluginUiStyleVariables(() => undefined);
  }
  const style = getComputedStyle(document.documentElement);
  return buildPluginUiStyleVariables((token) => style.getPropertyValue(token));
}
