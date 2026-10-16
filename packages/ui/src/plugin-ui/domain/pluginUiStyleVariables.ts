import type { McpAppsStyleVariables } from "@zcode/shared/mcp-apps";

/**
 * ZCode 主题 token（DESIGN.md / docs/design/zcode-tokens.md）→ MCP Apps 标准样式变量
 * （官方 `McpUiStyleVariableKey`）。每个标准键给出来源 token 与兜底字面量：token 读不到（非 DOM 环境、
 * 旧主题缺项）时用兜底，保证页面拿到的每个键都是可用的 CSS 值。颜色值原样透传（含 color-mix()）。
 */
export interface PluginUiStyleVariableSource {
  token?: string;
  fallback: string;
}

const SYSTEM_SANS =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif';
const SYSTEM_MONO =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

export const PLUGIN_UI_STYLE_VARIABLE_SOURCES: Record<string, PluginUiStyleVariableSource> = {
  "--color-background-primary": { token: "--color-background", fallback: "#ffffff" },
  "--color-background-secondary": { token: "--color-panel", fallback: "#f5f5f5" },
  "--color-background-tertiary": { token: "--color-surface", fallback: "#ededed" },
  "--color-background-inverse": { token: "--color-primary", fallback: "#0a0a0a" },
  "--color-background-ghost": { token: "--color-hover", fallback: "#e5e5e5" },
  "--color-background-info": { token: "--color-accent", fallback: "#f0f9ff" },
  "--color-background-danger": { token: "--color-destructive", fallback: "#dc2626" },
  "--color-background-success": { token: "--color-success", fallback: "#16a34a" },
  "--color-background-warning": { token: "--color-warning", fallback: "#ca8a04" },
  "--color-background-disabled": { token: "--color-secondary", fallback: "#d4d4d4" },
  "--color-text-primary": { token: "--color-foreground", fallback: "#404040" },
  "--color-text-secondary": { token: "--color-foreground-subtle", fallback: "#737373" },
  "--color-text-tertiary": { token: "--color-foreground-subtlest", fallback: "#a3a3a3" },
  "--color-text-inverse": { token: "--color-primary-foreground", fallback: "#fafafa" },
  "--color-text-ghost": { token: "--color-foreground-subtlest", fallback: "#a3a3a3" },
  "--color-text-info": { token: "--color-brand", fallback: "#38bdf8" },
  "--color-text-danger": { token: "--color-destructive", fallback: "#dc2626" },
  "--color-text-success": { token: "--color-success", fallback: "#16a34a" },
  "--color-text-warning": { token: "--color-warning", fallback: "#ca8a04" },
  "--color-text-disabled": { token: "--color-foreground-subtlest", fallback: "#a3a3a3" },
  "--color-border-primary": { token: "--color-border", fallback: "rgba(10, 10, 10, 0.1)" },
  "--color-border-secondary": { token: "--color-border-hover", fallback: "rgba(10, 10, 10, 0.2)" },
  "--color-border-tertiary": { token: "--color-card-border", fallback: "rgba(10, 10, 10, 0.1)" },
  "--color-border-inverse": { token: "--color-primary", fallback: "#0a0a0a" },
  "--color-border-ghost": { token: "--color-surface", fallback: "rgba(10, 10, 10, 0.03)" },
  "--color-border-info": { token: "--color-brand", fallback: "#38bdf8" },
  "--color-border-danger": { token: "--color-destructive", fallback: "#dc2626" },
  "--color-border-success": { token: "--color-success", fallback: "#16a34a" },
  "--color-border-warning": { token: "--color-warning", fallback: "#ca8a04" },
  "--color-border-disabled": { token: "--color-secondary", fallback: "#d4d4d4" },
  "--color-ring-primary": { token: "--color-brand", fallback: "#38bdf8" },
  "--color-ring-secondary": { token: "--color-border-hover", fallback: "rgba(10, 10, 10, 0.2)" },
  "--color-ring-inverse": { token: "--color-primary", fallback: "#0a0a0a" },
  "--color-ring-info": { token: "--color-brand", fallback: "#38bdf8" },
  "--color-ring-danger": { token: "--color-destructive", fallback: "#dc2626" },
  "--color-ring-success": { token: "--color-success", fallback: "#16a34a" },
  "--color-ring-warning": { token: "--color-warning", fallback: "#ca8a04" },
  "--font-sans": { token: "--font-sans", fallback: SYSTEM_SANS },
  "--font-mono": { token: "--font-mono", fallback: SYSTEM_MONO },
  "--font-weight-normal": { fallback: "400" },
  "--font-weight-medium": { fallback: "500" },
  "--font-weight-semibold": { fallback: "600" },
  "--font-weight-bold": { fallback: "700" },
  "--font-text-xs-size": { token: "--text-ui-xs", fallback: "10px" },
  "--font-text-sm-size": { token: "--text-ui-sm", fallback: "12px" },
  "--font-text-md-size": { token: "--text-ui-base", fallback: "14px" },
  "--font-text-lg-size": { token: "--text-ui-lg", fallback: "16px" },
  "--font-heading-xs-size": { token: "--text-ui-lg", fallback: "16px" },
  "--font-heading-sm-size": { token: "--text-ui-xl", fallback: "18px" },
  "--font-heading-md-size": { fallback: "20px" },
  "--font-heading-lg-size": { fallback: "24px" },
  "--font-heading-xl-size": { fallback: "30px" },
  "--font-heading-2xl-size": { fallback: "36px" },
  "--font-heading-3xl-size": { fallback: "48px" },
  "--font-text-xs-line-height": { fallback: "1.5" },
  "--font-text-sm-line-height": { fallback: "1.5" },
  "--font-text-md-line-height": { fallback: "1.5" },
  "--font-text-lg-line-height": { fallback: "1.5" },
  "--font-heading-xs-line-height": { fallback: "1.25" },
  "--font-heading-sm-line-height": { fallback: "1.25" },
  "--font-heading-md-line-height": { fallback: "1.25" },
  "--font-heading-lg-line-height": { fallback: "1.2" },
  "--font-heading-xl-line-height": { fallback: "1.2" },
  "--font-heading-2xl-line-height": { fallback: "1.1" },
  "--font-heading-3xl-line-height": { fallback: "1.1" },
  "--border-radius-xs": { token: "--radius-xs", fallback: "2px" },
  "--border-radius-sm": { token: "--radius-sm", fallback: "4px" },
  "--border-radius-md": { token: "--radius-md", fallback: "6px" },
  "--border-radius-lg": { token: "--radius-lg", fallback: "8px" },
  "--border-radius-xl": { token: "--radius-xl", fallback: "12px" },
  "--border-radius-full": { fallback: "9999px" },
  "--border-width-regular": { fallback: "1px" },
  "--shadow-hairline": { fallback: "0 0 0 1px rgba(0, 0, 0, 0.05)" },
  "--shadow-sm": { fallback: "0 1px 2px rgba(0, 0, 0, 0.05)" },
  "--shadow-md": { fallback: "0 4px 6px -1px rgba(0, 0, 0, 0.1)" },
  "--shadow-lg": { fallback: "0 10px 15px -3px rgba(0, 0, 0, 0.1)" },
};

/** `readToken` 返回宿主根元素上该 token 的计算值（空串 / undefined 视为缺失）。 */
export function buildPluginUiStyleVariables(
  readToken: (token: string) => string | undefined,
): McpAppsStyleVariables {
  const variables: McpAppsStyleVariables = {};
  for (const [key, source] of Object.entries(PLUGIN_UI_STYLE_VARIABLE_SOURCES)) {
    const value = source.token ? readToken(source.token)?.trim() : undefined;
    variables[key] = value || source.fallback;
  }
  return variables;
}
