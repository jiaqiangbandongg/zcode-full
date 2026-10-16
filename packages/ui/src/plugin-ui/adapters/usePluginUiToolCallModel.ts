import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildTaskSidePaneMemoryKey,
  claimPluginUiSidePaneAutoOpen,
} from "@/lib/taskSidePaneMemory.js";
import { createPluginUiInteractions } from "@/plugin-ui/adapters/pluginUiInteractions.js";
import { usePluginUiHost } from "@/plugin-ui/adapters/usePluginUiHost.js";
import {
  getPluginUiManualPin,
  setPluginUiManualPin,
  subscribePluginUiDisclosure,
} from "@/plugin-ui/app/pluginUiDisclosureStore.js";
import {
  getPluginUiRowDisposition,
  subscribePluginUiInstances,
} from "@/plugin-ui/app/pluginUiInstanceStore.js";
import {
  claimPluginUiSurface,
  getPluginUiSurface,
  subscribePluginUiSurfaces,
} from "@/plugin-ui/app/pluginUiSurfaceStore.js";
import { buildPluginUiSurfaceKey } from "@/plugin-ui/contract.js";
import { appAllowsDisplayMode } from "@/plugin-ui/domain/buildPluginUiHostContext.js";
import {
  buildPluginUiToolResult,
  isPluginUiToolCancelled,
  readPluginUiToolInput,
} from "@/plugin-ui/domain/pluginUiToolFeed.js";
import { readPluginUiPresentation } from "@/plugin-ui/domain/readPluginUiPresentation.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/fileSummaryTypes.js";
import { resolveTheme } from "@/useTheme.js";
import type {
  McpAppsDisplayMode,
  PluginSandboxHandle,
  PluginUiScopeRef,
} from "@zcode/shared/mcp-apps";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { resolvePluginUiLogicalScope } from "../domain/pluginUiLogicalScope.js";

import type { PluginUiToolCallViewProps } from "@/plugin-ui/contract.js";

const INLINE_AND_FULLSCREEN: readonly McpAppsDisplayMode[] = ["inline", "fullscreen"];
const host_resourceShowInline = (handle: PluginSandboxHandle | null) =>
  handle?.resourceMeta?.showInline === true;
const INLINE_ONLY: readonly McpAppsDisplayMode[] = ["inline"];

/** 工具行到插件 UI 的适配；React 生命周期与宿主动作集中于此，视图只接收展示模型。 */
export function usePluginUiToolCallModel(
  context: ToolCallBlockRenderContext,
): Omit<PluginUiToolCallViewProps, "fallback"> {
  const { intl, locale } = useZCodeIntl();
  const presentation = useMemo(
    () => readPluginUiPresentation(context.toolCallNode.toolCall.raw),
    [context.toolCallNode.toolCall.raw],
  );
  const scope = context.pluginUi?.scope;
  const onOpenSidePane = context.pluginUi?.onOpenSidePane;
  const toolCall = context.toolCallNode.toolCall;
  const [width, setWidth] = useState(0);
  const [displayMode, setDisplayMode] = useState<McpAppsDisplayMode>("inline");
  // 资源级 showInline 只随句柄到达；经 ref 读避免把 host 结果卷进渲染期的派生。
  const hostHandleRef = useRef<PluginSandboxHandle | null>(null);
  const sessionId = scope?.sessionId ?? "";
  const toolScope = useMemo<PluginUiScopeRef>(
    () =>
      presentation?.surface
        ? { kind: "surface", surfaceId: presentation.surface }
        : { kind: "toolCall", toolCallId: toolCall.toolId },
    [toolCall.toolId, presentation?.surface],
  );
  const surfaceTarget = {
    workspacePath: scope?.workspacePath ?? context.workspacePath,
    workspaceIdentity: scope?.workspaceIdentity,
    sessionId,
    pluginId: presentation?.pluginId ?? "",
    serverName: presentation?.serverName,
    resourceUri: presentation?.resourceUri,
  };
  const toolSurfaceKey = buildPluginUiSurfaceKey(
    surfaceTarget,
    resolvePluginUiLogicalScope(presentation ?? {}, toolScope),
  );
  // 面板路由目标：工具声明了 surface 时，"侧栏是否已接管"看面板 tab 而不是工具卡片 tab。
  const routedSurfaceKey = presentation?.surface
    ? buildPluginUiSurfaceKey(surfaceTarget, { kind: "surface", surfaceId: presentation.surface })
    : null;
  const sidePaneActive = useSyncExternalStore(
    subscribePluginUiSurfaces,
    () =>
      getPluginUiSurface(toolSurfaceKey) === "side-pane" ||
      (routedSurfaceKey !== null && getPluginUiSurface(routedSurfaceKey) === "side-pane"),
    () => false,
  );

  const toolInput = useMemo(() => readPluginUiToolInput(toolCall), [toolCall]);
  const toolResult = useMemo(
    () => buildPluginUiToolResult(toolCall, presentation),
    [presentation, toolCall],
  );
  // 4b-1：时间线推导的展示裁决（被替代 / 强制常驻）与用户手动固定状态。
  const disposition = useSyncExternalStore(
    subscribePluginUiInstances,
    () => getPluginUiRowDisposition(sessionId, toolCall.toolId),
    () => undefined,
  );
  const manualPin = useSyncExternalStore(
    subscribePluginUiDisclosure,
    () => getPluginUiManualPin(sessionId, toolCall.toolId),
    () => undefined,
  );
  const superseded = disposition?.superseded === true;
  const forcedInline =
    disposition?.forcedInline === true || host_resourceShowInline(hostHandleRef.current);
  const pinned = manualPin ?? (forcedInline || disposition?.autoExpand === true);
  const togglePin = useCallback(() => {
    setPluginUiManualPin(sessionId, toolCall.toolId, !pinned);
  }, [pinned, sessionId, toolCall.toolId]);

  const openInSidePane = useCallback(() => {
    if (!presentation) return;

    onOpenSidePane?.({
      // surface 工具打开的是面板 tab（结果随后路由进面板），普通工具打开工具卡片 tab。
      ...(presentation.surface
        ? { surfaceId: presentation.surface, serverName: presentation.serverName }
        : { toolCallId: toolCall.toolId, serverName: presentation.serverName }),
      pluginId: presentation.pluginId,
      resourceUri: presentation.resourceUri,
      title: toolCall.title ?? presentation.pluginId,
    });
  }, [
    onOpenSidePane,
    presentation,
    routedSurfaceKey,
    toolCall.title,
    toolCall.toolId,
    toolSurfaceKey,
  ]);

  const handleDisplayModeRequest = useCallback(
    (mode: McpAppsDisplayMode) => {
      if (mode === "fullscreen" && onOpenSidePane) {
        openInSidePane();
        return "fullscreen";
      }
      setDisplayMode(mode);
      return mode;
    },
    [onOpenSidePane, openInSidePane],
  );
  const handleOpenExternal = useCallback(
    (url: string) => context.onOpenBrowserUrl?.(url),
    [context.onOpenBrowserUrl],
  );

  // MCP 的业务失败仍可能是 completed 且带 UI 元数据；只检查有结果会让错误行争抢同一页面并留下空白卡片。
  // 展示条件：失败/取消只留普通记录，不能建锚点或自动开侧栏；原始 tool-result 不改写。
  const supportedScope =
    Boolean(presentation && scope?.sessionId) &&
    toolCall.status !== "failed" &&
    !isPluginUiToolCancelled(toolCall) &&
    presentation?.isError !== true;
  // 页面握手声明的 availableDisplayModes 是硬约束（规范 MUST NOT）：不含 fullscreen 时不给侧栏入口、不自动打开。
  // 能力在 initialized 后才到，先按"都支持"起步；到达后经 availableDisplayModes 变化推 host-context-changed。
  const [appAllowsFullscreen, setAppAllowsFullscreen] = useState(true);
  const canOpenSidePane = Boolean(onOpenSidePane) && appAllowsFullscreen;
  const interactions = useMemo(
    () =>
      scope?.sessionId && presentation
        ? createPluginUiInteractions({
            ...scope,
            sessionId: scope.sessionId,
            pluginId: presentation.pluginId,
            scope: toolScope,
          })
        : undefined,
    [presentation, scope, toolScope],
  );
  // 侧栏接管时内联撤掉展示锚点，管理器继续持有同一个活页面。
  // 被替代的行只留普通记录；结果未就绪（pending / running）时只占位，沙箱在结果到达后才建。
  const resultReady = toolResult !== undefined;
  const inlineActive = supportedScope && !sidePaneActive && !superseded && resultReady;
  const host = usePluginUiHost({
    presentation: presentation ?? { serverName: "", pluginId: "", resourceUri: "" },
    scope: {
      workspacePath: scope?.workspacePath ?? context.workspacePath,
      remoteSessionId: scope?.remoteSessionId ?? undefined,
      ...(scope?.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      sessionId,
      scope: toolScope,
    },
    theme: resolveTheme(context.theme ?? "system"),
    locale,
    displayMode,
    toolInput,
    toolResult,
    toolCancelled: isPluginUiToolCancelled(toolCall),
    hostVersion: "zcode",
    // 没有侧栏入口（如只读 / 非桌面壳）或页面不支持 fullscreen 时只声明 inline。
    availableDisplayModes: canOpenSidePane ? INLINE_AND_FULLSCREEN : INLINE_ONLY,
    onDisplayModeRequest: handleDisplayModeRequest,
    onOpenExternal: handleOpenExternal,
    width,
    enabled: inlineActive,
    ...(interactions ? { interactions } : {}),
  });
  hostHandleRef.current = host.handle;
  useEffect(() => {
    setAppAllowsFullscreen(appAllowsDisplayMode(host.appCapabilities, "fullscreen"));
  }, [host.appCapabilities]);
  // 资源级 showInline（随句柄到达）：没有手动记录时写成固定，之后折叠边界据此重算。
  useEffect(() => {
    if (!supportedScope || host.handle?.resourceMeta?.showInline !== true || !sessionId) return;
    if (getPluginUiManualPin(sessionId, toolCall.toolId) === undefined) {
      setPluginUiManualPin(sessionId, toolCall.toolId, true);
    }
  }, [host.handle, sessionId, supportedScope, toolCall.toolId]);

  useEffect(() => {
    if (!inlineActive || !host.supported) return;
    return claimPluginUiSurface(toolSurfaceKey, "inline");
  }, [inlineActive, host.supported, toolSurfaceKey]);

  // preferredDisplayMode: fullscreen → 工具卡片一出现就自动打开侧栏一次。
  // 不等结果：replay / 极快模型下结果到达与回合收起可能在同一批提交，等结果会让 effect 永远没机会跑。
  // 结果稍后由侧栏从实时投影按 toolCallId / surfaceId 自行读取。
  const autoOpenKey =
    presentation?.preferredDisplayMode === "fullscreen"
      ? buildPluginUiSurfaceKey(surfaceTarget, { kind: "toolCall", toolCallId: toolCall.toolId })
      : null;
  const sidePaneMemoryKey = buildTaskSidePaneMemoryKey({
    workspacePath: surfaceTarget.workspacePath,
    workspaceIdentity: surfaceTarget.workspaceIdentity,
    taskId: sessionId,
  });
  useEffect(() => {
    if (
      !supportedScope ||
      // 历史展开会重新挂载旧 fullscreen 行；必须同步禁止自动打开，否则旧卡片会抢回侧栏。
      superseded ||
      !host.supported ||
      !autoOpenKey ||
      !canOpenSidePane
    )
      return;
    // 已经在侧栏的调用也要消费；否则关闭后重新挂载会补触发，覆盖用户关闭状态。
    if (!claimPluginUiSidePaneAutoOpen(sidePaneMemoryKey, autoOpenKey)) return;
    if (getPluginUiSurface(routedSurfaceKey ?? toolSurfaceKey) === "side-pane") return;
    openInSidePane();
  }, [
    supportedScope,
    superseded,
    host.supported,
    autoOpenKey,
    sidePaneMemoryKey,
    canOpenSidePane,
    openInSidePane,
    routedSurfaceKey,
    toolSurfaceKey,
  ]);

  return {
    supported: supportedScope && host.supported,
    surface: presentation?.surface,
    preferredDisplayMode: presentation?.preferredDisplayMode ?? "inline",
    sidePaneActive,
    host,
    // 资源级声明优先，工具级兜底，都没有默认画边框。
    prefersBorder: host.handle?.resourceMeta?.prefersBorder ?? presentation?.prefersBorder ?? true,
    superseded,
    ...(supportedScope && !superseded ? { pinned, onTogglePin: togglePin } : {}),
    pinLabel: intl.formatMessage({ id: "pluginUi.pin" }),
    unpinLabel: intl.formatMessage({ id: "pluginUi.unpin" }),
    loadingLabel: intl.formatMessage({ id: "pluginUi.loading" }),
    errorLabel: intl.formatMessage({ id: "pluginUi.loadFailed" }),
    retryLabel: intl.formatMessage({ id: "pluginUi.retry" }),
    openedLabel: intl.formatMessage({ id: "pluginUi.openedInSidePane" }),
    openLabel: intl.formatMessage({ id: "pluginUi.openInSidePane" }),
    onWidthChange: setWidth,
    onOpenSidePane: canOpenSidePane ? openInSidePane : undefined,
  };
}
