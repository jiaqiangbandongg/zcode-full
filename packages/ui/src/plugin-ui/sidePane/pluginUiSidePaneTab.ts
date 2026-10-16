import type { WorkspaceSidePaneState } from "@/lib/workspaceSidePane.js";
import { activateSidePaneTab } from "@/lib/workspaceSidePane.js";
import type { OpenPluginUiSideTabRequest, PluginUiSidePaneTab } from "../contract.js";
import { buildPluginUiSidePaneTabId, readPluginUiScopeRef } from "../contract.js";

export type OpenScopedPluginUiSideTabRequest = OpenPluginUiSideTabRequest & {
  workspaceKey: string;
};

/**
 * 与 plan-detail 同构：按 workspaceKey + parentSessionId + 作用域派生稳定 id。
 * 工具卡片 `…:<toolCallId>`；面板 `…:surface:<surfaceId>`（面板 id 与 toolCallId 不同命名空间，前缀防撞）。
 */
export function createPluginUiSidePaneTab(
  options: OpenScopedPluginUiSideTabRequest,
): PluginUiSidePaneTab {
  const scope = readPluginUiScopeRef(options);
  if (!scope) throw new Error("plugin-ui side tab needs toolCallId or surfaceId");
  return {
    id: buildPluginUiSidePaneTabId(options),
    type: "plugin-ui",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    ...(scope.kind === "toolCall"
      ? { toolCallId: scope.toolCallId }
      : { surfaceId: scope.surfaceId }),
    ...(options.serverName ? { serverName: options.serverName } : {}),
    pluginId: options.pluginId,
    resourceUri: options.resourceUri,
    title: options.title,
  };
}

/** 同一作用域只保留一个 tab；重复打开只刷新标题并激活。 */
export function openPluginUiSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedPluginUiSideTabRequest,
): WorkspaceSidePaneState {
  const nextTab = createPluginUiSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is PluginUiSidePaneTab => tab.type === "plugin-ui" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, title: nextTab.title } : nextTab);
}
