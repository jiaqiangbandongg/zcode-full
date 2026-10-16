import type {
  McpUiAppCapabilities,
  McpUiDisplayMode,
  McpUiHostContext,
  McpUiStyles,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpAppsHostTitleBar, McpAppsStyleVariables } from "@zcode/shared/mcp-apps";
import { PLUGIN_UI_CARD_MAX_HEIGHT_PX } from "../contract.js";

export interface PluginUiHostContextInput {
  theme: "light" | "dark";
  locale: string;
  displayMode: McpUiDisplayMode;
  /** 容器宽度（px）；未知时 0。 */
  width: number;
  /** 卡片高度上限（规范 `containerDimensions.maxHeight`：页面据此裁决 size-changed）；缺省宿主上限。 */
  maxHeight?: number;
  timeZone?: string;
  /** fullscreen 容器的头部；inline 不传。宿主提供的扩展键（hostContext 允许附加键）。 */
  titleBar?: McpAppsHostTitleBar;
  /** 本实例真实可切换到的模式；缺省两种都可。 */
  availableDisplayModes?: readonly McpUiDisplayMode[];
  /** 主题 token 映射成的 MCP Apps 标准变量；缺省不带 styles。 */
  styleVariables?: McpAppsStyleVariables;
}

/** hostContext 的唯一构造点。 */
export function buildPluginUiHostContext(input: PluginUiHostContextInput): McpUiHostContext {
  return {
    theme: input.theme,
    locale: input.locale,
    displayMode: input.displayMode,
    availableDisplayModes: [...(input.availableDisplayModes ?? ["inline", "fullscreen"])],
    // 规范：内联卡片高度跟随内容（size-changed），宿主只给上限；宽度是确定值。
    containerDimensions: {
      width: Math.max(0, Math.round(input.width)),
      maxHeight: input.maxHeight ?? PLUGIN_UI_CARD_MAX_HEIGHT_PX,
    },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    platform: "desktop",
    userAgent: "zcode",
    timeZone: input.timeZone ?? resolveTimeZone(),
    // 桌面宿主固定有 hover、无 touch。
    deviceCapabilities: { hover: true, touch: false },
    ...(input.styleVariables ? { styles: { variables: input.styleVariables as McpUiStyles } } : {}),
    ...(input.titleBar ? { titleBar: input.titleBar } : {}),
  };
}

function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** 页面未声明 `availableDisplayModes` 视为都支持；声明了就只能切到声明过的模式（规范 MUST NOT）。 */
export function appAllowsDisplayMode(
  capabilities: McpUiAppCapabilities | undefined,
  mode: McpUiDisplayMode,
): boolean {
  const declared = capabilities?.availableDisplayModes;
  return !declared || declared.includes(mode);
}

/** 内联实例收到 `ui/request-display-mode`：只在宿主可用集合内切换，`pip` 与不可用的模式如实回当前模式。 */
export function resolveRequestedDisplayMode(
  requested: McpUiDisplayMode,
  current: McpUiDisplayMode,
  available: readonly McpUiDisplayMode[],
): McpUiDisplayMode {
  return requested !== "pip" && available.includes(requested) ? requested : current;
}

/**
 * 侧栏实例收到 `ui/request-display-mode`：只有该作用域在会话流里还有内联卡片可接管时，请求 inline 才成立
 * （宿主关面板、回 inline）；否则如实回 fullscreen。pip 同样落回 fullscreen。
 */
export function resolveSidePaneDisplayModeRequest(
  requested: McpUiDisplayMode,
  canReturnInline: boolean,
): McpUiDisplayMode {
  return requested === "inline" && canReturnInline ? "inline" : "fullscreen";
}
