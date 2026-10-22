import { readPluginUiStyleVariables } from "@/plugin-ui/hostPrimitives.js";
import { GEN_UI_STYLE_CONTEXT_KEY, genUiStyleVariablesSchema } from "@zcode/shared/gen-ui";
import { McpUiHostStylesSchema } from "@modelcontextprotocol/ext-apps";

/** Gen UI 使用正文层级与中性色控件；不覆盖第三方 MCP App 的标准 token 投影。 */
export function readGenUiStyleContext() {
  const variables = readPluginUiStyleVariables();
  const root = getComputedStyle(document.documentElement);
  const size = Number.parseFloat(root.getPropertyValue("--ui-font-size")) || 14;
  const tokens = [
    "primary",
    "primary-foreground",
    "secondary",
    "foreground-subtlest",
    "card",
    "card-border",
    "input",
    "input-focused",
    "input-border",
    "input-border-hover",
    "input-border-focused",
    "hover",
    "selected",
    "border",
    "border-hover",
  ];
  // 标准 MCP primary 带品牌强调语义；Gen UI 控件独立投影，不能连带改变图表和链接。
  const controls = Object.fromEntries(
    tokens.flatMap((token) => {
      const value = root.getPropertyValue(`--color-${token}`).trim();
      return value ? [[`--gen-ui-${token}`, value]] : [];
    }),
  );
  return {
    // SDK 严格校验标准 variables 的枚举键；专用颜色走既有扩展上下文，避免握手失败。
    [GEN_UI_STYLE_CONTEXT_KEY]: genUiStyleVariablesSchema.parse(controls),
    styles: {
      variables: McpUiHostStylesSchema.shape.variables.unwrap().parse({
        ...variables,
        "--font-text-md-size": `${size}px`,
        "--font-text-sm-size": `${size - 2}px`,
        "--font-heading-xs-size": `${size}px`,
        "--font-heading-sm-size": `${size + 2}px`,
        "--font-heading-md-size": `${size + 4}px`,
      }),
    },
  };
}
