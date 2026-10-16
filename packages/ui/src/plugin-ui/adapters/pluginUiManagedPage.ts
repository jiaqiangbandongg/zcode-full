import { getPluginUiSessionActions } from "./pluginUiSessionActions.js";
import { logger } from "@/logger.js";
import { createPluginUiMessagePortTransport } from "@/plugin-ui/adapters/messagePortTransport.js";
import { createPluginUiDownloadInteraction } from "@/plugin-ui/adapters/pluginUiDownloads.js";
import { readPluginUiStyleVariables } from "@/plugin-ui/adapters/readPluginUiStyleVariables.js";
import {
  createPluginUiHostController,
  type PluginUiHostController,
  type PluginUiHostPhase,
} from "@/plugin-ui/app/pluginUiHostController.js";
import { createPluginUiResourceNotificationRegistrar } from "@/plugin-ui/app/pluginUiResourceNotificationBus.js";
import {
  clearPluginUiWidgetState,
  getPluginUiWidgetState,
  setPluginUiWidgetState,
} from "@/plugin-ui/app/pluginUiWidgetStateStore.js";
import type {
  McpUiAppCapabilities,
  McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { buildPluginSandboxScopeId } from "@zcode/shared/mcp-apps";
import { clearPluginUiSurfaceFeed } from "../app/pluginUiSurfaceFeedStore.js";
import {
  PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX,
  PLUGIN_UI_CARD_MAX_HEIGHT_PX,
  PLUGIN_UI_CARD_MIN_HEIGHT_PX,
} from "../contract.js";
import { buildPluginUiHostCapabilities } from "../domain/buildPluginUiHostCapabilities.js";
import { buildPluginUiHostContext } from "../domain/buildPluginUiHostContext.js";

import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { buildPluginUiSessionKey } from "../contract.js";
import type { Page, UsePluginUiHostInput, UsePluginUiHostResult } from "./pluginUiHostTypes.js";
import { createPluginUiPagePlane } from "./pluginUiPagePlane.js";
import { pluginUiPages } from "./pluginUiPageRegistry.js";
import { attachPluginUiResourceDeltaFeed } from "./pluginUiResourceDeltaFeed.js";
type Platform = IPlatformService;
type Services = IServiceAccessor;
export function createPage(
  key: string,
  input: UsePluginUiHostInput,
  platform: Platform,
  services: Services,
): Page {
  const bridge = services.pluginUiBridgeService!;
  const sandboxPlatform = platform.pluginSandbox!;
  const surfaceKey = key;
  const latest = { current: input };
  const listeners = new Set<() => void>();
  let controller: PluginUiHostController | null = null;
  let releaseFeed: (() => void) | undefined;
  let releaseLease: (() => void) | undefined;
  let disposed = false;
  let starting = false;
  let incarnation = 0;
  let releasing: Promise<unknown> = Promise.resolve();
  let contextInputs = "";
  let lastFeed = "";
  let lastContext = "";
  let appIdentity: string | undefined;
  const notify = () => {
    for (const listener of listeners) listener();
  };
  let snapshot: UsePluginUiHostResult = {
    pageKey: key,
    supported: true,
    phase: "idle",
    handle: null,
    height: PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX,
    error: null,
    appCapabilities: undefined,
    reload: () => {
      clearPluginUiWidgetState(key);
      void page.suspend(true).then(ensure);
    },
  };
  const patch = (value: Partial<UsePluginUiHostResult>) => {
    snapshot = { ...snapshot, ...value };
    notify();
  };
  const setPhase = (phase: PluginUiHostPhase) => patch({ phase });
  const setHandle = (handle: PluginSandboxHandle) => {
    if (appIdentity && appIdentity !== handle.instance.appIdentity) clearPluginUiWidgetState(key);
    appIdentity = handle.instance.appIdentity;
    patch({ handle });
    plane.mount(handle);
  };
  const setHeight = (height: number) => patch({ height });
  const setError = (error: string) => patch({ error });
  const setAppCapabilities = (appCapabilities: McpUiAppCapabilities | undefined) =>
    patch({ appCapabilities });
  const plane = createPluginUiPagePlane({
    onVisibility(visible) {
      if (page.visible !== visible) pluginUiPages.visibility(page, visible);
      if (visible) ensure();
    },
    onCrash() {
      void page.suspend(true);
      patch({ phase: "error", error: "MCP App page stopped" });
    },
  });
  async function ensure() {
    if (disposed || controller || starting || snapshot.phase === "error") return;
    starting = true;
    const epoch = ++incarnation;
    try {
      await releasing;
      if (disposed || epoch !== incarnation) return;
      await pluginUiPages.reserve(page);
    } catch (error) {
      starting = false;
      patch({ phase: "error", error: String(error) });
      return;
    }
    if (disposed || epoch !== incarnation) {
      pluginUiPages.released(page);
      return;
    }
    starting = false;
    try {
      // 页面独立持有已有 workspace 连接租约；卡片或 pane 退出不会让后台页面失联。
      const connection = acquireWorkspaceConnection(
        latest.current.scope,
        services.zcodeAgentService,
        platform.createLocalMediaPreviewUrl,
      );
      releaseLease = () => connection.release();
      const lease = connection.layer.acquire(latest.current.scope.sessionId);
      const runtimeStopped = () => {
        void page.suspend(true);
        patch({ phase: "error", error: "MCP App runtime is no longer available" });
      };
      const offRestart = connection.transport.onRuntimeRestart(runtimeStopped);
      const offLifecycle = connection.transport.onRuntimeLifecycle?.((state) => {
        if (state === "unavailable") runtimeStopped();
      });
      releaseLease = () => {
        offRestart();
        offLifecycle?.();
        lease.release();
        connection.release();
      };
      releaseFeed = attachPluginUiResourceDeltaFeed(lease.store, latest.current.scope);
      patch({ phase: "preparing", error: null, handle: null });
      createController();
    } catch (error) {
      void page.suspend(true);
      patch({ phase: "error", error: String(error) });
    }
  }
  function createController() {
    const initialHostContext: McpUiHostContext = buildPluginUiHostContext({
      theme: latest.current.theme,
      locale: latest.current.locale,
      displayMode: latest.current.displayMode,
      width: latest.current.width,
      ...(latest.current.titleBar ? { titleBar: latest.current.titleBar } : {}),
      ...(latest.current.availableDisplayModes
        ? { availableDisplayModes: latest.current.availableDisplayModes }
        : {}),
      // 主题 token 随初始 hostContext 下发，主题切换时经 updateHostContext 更新。
      styleVariables: readPluginUiStyleVariables(),
    });
    const scope = latest.current.scope;
    const presentation = latest.current.presentation;
    // 平台交互（downloadFile）与调用方注入的会话交互合成一份；能力声明按合成后的回调是否存在。
    const platformInteractions = createPluginUiDownloadInteraction({
      platform,
      bridge,
      scope,
      presentation,
      getInstance: () => {
        if (!snapshot.handle) throw new Error("MCP App is not prepared");
        return snapshot.handle.instance;
      },
    });
    const nextController = createPluginUiHostController({
      bridge,
      sampling: services?.pluginUiSamplingService,
      ...(services?.pluginUiAppToolsService ? { appTools: services.pluginUiAppToolsService } : {}),
      createTransport: createPluginUiMessagePortTransport,
      platform: sandboxPlatform,
      scope,
      presentation,
      // 按代际登记到路由表；该会话的投影 store 收到 pluginUi.* 增量后按 (scopeId, generation) 投递。
      resourceNotifications: createPluginUiResourceNotificationRegistrar(
        scope,
        presentation.serverName,
      ),
      initialHostContext,
      hostVersion: latest.current.hostVersion,
      getToolFeed: () => ({
        ...(latest.current.toolInput ? { toolInput: { arguments: latest.current.toolInput } } : {}),
        ...(latest.current.toolResult ? { toolResult: latest.current.toolResult } : {}),
        ...(latest.current.toolCancelled ? { toolCancelled: true } : {}),
      }),
      // widgetState 初值直接读宿主内存 store（唯一 owner），不经 props 再缓存一份；
      // 端口投递时才读，离屏回收后重建也拿到页面最近一次主动保存的值。
      getWidgetState: () => getPluginUiWidgetState(surfaceKey),
      getHostCapabilities: () =>
        buildPluginUiHostCapabilities({
          canSendFollowUpMessage: Boolean(latest.current.interactions?.onSendFollowUpMessage),
          canUpdateModelContext: Boolean(latest.current.interactions?.onUpdateModelContext),
          canSetWidgetState: true,
          canSample: Boolean(services?.pluginUiSamplingService && getPluginUiSessionActions(scope)),
          canSubscribeResources: true,
          canDownloadFile: Boolean(platformInteractions?.onDownloadFile),
          ...(scope.scope.kind === "surface" ? { surfaceId: scope.scope.surfaceId } : {}),
        }),
      ...platformInteractions,
      // 经 latest ref 转调，回调 identity 变化不触发 controller 重建；缺省回 -32601（端口层翻译成 ProtocolError）。
      onSendFollowUpMessage: (payload, context) =>
        latest.current.interactions?.onSendFollowUpMessage
          ? latest.current.interactions.onSendFollowUpMessage(payload, context)
          : Promise.reject(Object.assign(new Error("Not supported"), { code: -32601 })),
      onUpdateModelContext: (payload) =>
        latest.current.interactions?.onUpdateModelContext
          ? latest.current.interactions.onUpdateModelContext(payload)
          : Promise.reject(Object.assign(new Error("Not supported"), { code: -32601 })),
      onUpdateWidgetState: async (widgetState) => {
        setPluginUiWidgetState(surfaceKey, widgetState);
      },
      onPhase: (next, detail) => {
        if (controller !== nextController) return;
        // 生命周期事件每个沙箱只有几条，走 lifecycle 才能进主日志（排查用户现场用）。
        logger.lifecycle.info("[plugin-ui] lifecycle", {
          phase: next,
          sessionId: latest.current.scope.sessionId,
          pluginId: latest.current.presentation.pluginId,
          scopeId: buildPluginSandboxScopeId(latest.current.scope.scope),
          ...(detail?.error ? { error: detail.error } : {}),
        });
        if (next === "error") {
          void page.suspend(true);
          patch({ phase: "error", error: detail?.error ?? "MCP App failed" });
          return;
        }
        setPhase(next);
        if (detail?.handle) {
          setHandle(detail.handle);
          // 资源声明的初始高度替代固定 240；仍受 min / max clamp。
          const hint = detail.handle.resourceMeta?.heightHint;
          if (hint !== undefined) setHeight(clampCardHeight(hint, detail.handle));
          // 资源声明的浏览器权限随句柄到达（早于端口），进 hostContext 让页面 feature detect（规范草案 `permissions`）。
          const permissions = detail.handle.resourceMeta?.permissions;
          if (permissions?.length) {
            nextController.updateHostContext({
              permissions: Object.fromEntries(permissions.map((item) => [item, {}])),
            });
          }
        }
        if (detail?.error) setError(detail.error);
      },
      onInstanceClosed: () => {
        void page.suspend(true);
        clearPluginUiWidgetState(key);
        patch({ phase: "error", error: "MCP App connection is no longer available" });
      },
      onBusyChange: () => {
        if (controller === nextController) pluginUiPages.settled(page);
      },
      onAppCapabilities: setAppCapabilities,
      onHeight: (next) => setHeight(clampCardHeight(next, snapshot.handle)),
      onDisplayModeRequest: (mode) => latest.current.onDisplayModeRequest?.(mode) ?? mode,
      onOpenExternal: (url) => latest.current.onOpenExternal?.(url),
      log: (message, detail) => logger.warn(message, detail),
    });

    controller = nextController;
    controller.start();
  }
  const task = buildPluginUiSessionKey(input.scope);
  const workspaceEvents = services.zcodeTaskService.onDynamicWorkspaceEvent({
    workspacePath: input.scope.workspacePath,
    workspaceIdentity: input.scope.workspaceIdentity,
  })((event) => {
    if (
      event.type === "workspace_task_list_changed" &&
      event.reason === "task_deleted" &&
      event.taskId === input.scope.sessionId
    )
      pluginUiPages.removeTask(task);
  });
  const page: Page = {
    kind: "mcp",
    key,
    task,
    visible: false,
    snapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    busy: () => controller?.isBusy() ?? false,
    running: () => controller !== null || starting,
    bind(node, sidebar) {
      const off = plane.bind({
        node,
        kind: sidebar ? "sidebar" : "inline",
        container: node.closest<HTMLElement>("[data-sandbox-page-container]") ?? undefined,
      });
      ensure();
      return off;
    },
    update(next) {
      // 背景内联锚点不能覆盖侧栏当前的交互上下文。
      if (next.enabled === false) return;
      latest.current = next;
      const nextContextInputs = JSON.stringify([
        next.theme,
        next.locale,
        next.displayMode,
        next.width,
        next.titleBar,
        next.availableDisplayModes,
      ]);
      if (nextContextInputs !== contextInputs) {
        contextInputs = nextContextInputs;
        const context = buildPluginUiHostContext({
          theme: next.theme,
          locale: next.locale,
          displayMode: next.displayMode,
          width: next.width,
          titleBar: next.titleBar,
          availableDisplayModes: next.availableDisplayModes,
          styleVariables: readPluginUiStyleVariables(),
        });
        const contextKey = JSON.stringify(context);
        if (contextKey !== lastContext) {
          lastContext = contextKey;
          controller?.updateHostContext(context);
        }
      }
      const feed = JSON.stringify([
        next.toolCallId,
        next.toolInput,
        next.toolResult,
        next.toolCancelled,
      ]);
      if (feed !== lastFeed) {
        lastFeed = feed;
        if (next.toolInput) controller?.notifyToolInput({ arguments: next.toolInput });
        if (next.toolResult) controller?.notifyToolResult(next.toolResult);
        if (next.toolCancelled) controller?.notifyToolCancelled();
      }
    },
    async suspend(force = false) {
      const candidate = controller;
      if (!force && (starting || (candidate && !(await candidate.tryRecycle().catch(() => false)))))
        return false;
      // 审批接纳与后台回收在 Agent 原子裁决；等待期间替换的 controller 不受旧结果影响。
      if (!force && candidate !== controller) return false;
      incarnation++;
      starting = false;
      const previous = controller;
      controller = null;
      const previousHandle = snapshot.handle;
      const offFeed = releaseFeed,
        offLease = releaseLease;
      releaseFeed = undefined;
      releaseLease = undefined;
      patch({ phase: "idle", handle: null, appCapabilities: undefined });
      // 先前释放未完成时不能重新预备；反复重试也只等待同一个释放链。
      // Main 主动导航到 about:blank 会触发 navigation；先解除旧代际观察，避免回收被误报为崩溃。
      if (previousHandle) plane.prepareUnmount(previousHandle.sandboxId);
      const closing = previous?.dispose();
      releasing = Promise.all([releasing, closing]).then(() => {
        if (previousHandle) plane.unmount(previousHandle.sandboxId);
        offFeed?.();
        offLease?.();
        pluginUiPages.released(page);
      });
      await releasing;
      // 等待 Agent 回收答复时锚点可能重新可见；释放完成后由同一 owner 恢复，避免停在空页面。
      if (!force && page.visible && !disposed) void ensure();
      return true;
    },
    destroy() {
      workspaceEvents.dispose();
      clearPluginUiSurfaceFeed(key);
      disposed = true;
      void page.suspend(true).finally(() => plane.dispose());
      clearPluginUiWidgetState(key);
      listeners.clear();
    },
  };
  return page;
}

/** 卡片高度 clamp：下限取资源 `minFrameHeight` 与宿主最小值的较大者，上限固定。 */
function clampCardHeight(next: number, handle: PluginSandboxHandle | null): number {
  const min = Math.max(PLUGIN_UI_CARD_MIN_HEIGHT_PX, handle?.resourceMeta?.minFrameHeight ?? 0);
  return Math.min(PLUGIN_UI_CARD_MAX_HEIGHT_PX, Math.max(min, next));
}
