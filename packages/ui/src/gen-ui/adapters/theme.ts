import { readPluginUiStyleVariables } from "@/plugin-ui/hostPrimitives.js";

/** Gen UI 使用正文层级与中性色控件；不覆盖第三方 MCP App 的标准 token 投影。 */
export function readGenUiStyleVariables(): Record<string, string> {
  const variables = readPluginUiStyleVariables();
  const root = getComputedStyle(document.documentElement);
  const size = Number.parseFloat(root.getPropertyValue("--ui-font-size")) || 14;
  return {
    ...variables,
    "--font-text-md-size": `${size}px`,
    "--font-text-sm-size": `${Math.max(11, size - 2)}px`,
  };
}
