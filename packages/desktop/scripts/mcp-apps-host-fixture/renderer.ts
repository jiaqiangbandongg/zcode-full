import {
  createPluginUiHostController,
  type PluginUiHostController,
} from "../../../ui/src/plugin-ui/app/pluginUiHostController.js";
import { PluginUiPageManager } from "../../../ui/src/plugin-ui/app/pluginUiPageManager.js";
import {
  getPluginUiWidgetState,
  setPluginUiWidgetState,
  clearPluginUiWidgetState,
} from "../../../ui/src/plugin-ui/app/pluginUiWidgetStateStore.js";
import type { PluginSandboxHandle, PluginSandboxPortsEvent } from "@zcode/shared/mcp-apps";
import { createPluginUiMessagePortTransport } from "../../../ui/src/plugin-ui/adapters/messagePortTransport.js";
import { createPluginUiPagePlane } from "../../../ui/src/plugin-ui/adapters/pluginUiPagePlane.js";
const harness = (window as any).harness;
// 记录生产承载层的活动 window 监听器，重复切换后必须保持恒定。
const tracked = new Map<string, Set<EventListenerOrEventListenerObject>>();
const add = window.addEventListener.bind(window),
  remove = window.removeEventListener.bind(window);
(window as any).addEventListener = (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options: any,
) => {
  const entries = tracked.get(type) ?? new Set();
  entries.add(listener);
  tracked.set(type, entries);
  add(type, listener, options);
};
(window as any).removeEventListener = (
  type: string,
  listener: EventListenerOrEventListenerObject,
  options: any,
) => {
  tracked.get(type)?.delete(listener);
  remove(type, listener, options);
};
let controller: PluginUiHostController;
let handshakes = 0;
let handle: PluginSandboxHandle;
let portHandler: ((event: PluginSandboxPortsEvent) => void) | undefined;
let ready = Promise.withResolvers<void>();
(window as any).harnessReady = ready.promise;
window.addEventListener("message", (event) => {
  if (event.data?.type !== "zcode:plugin-sandbox-ports" || event.ports.length !== 1) return;
  portHandler?.({ ...event.data, port: event.ports[0] });
});
const plane = createPluginUiPagePlane({
  onVisibility() {},
  onCrash() {
    throw new Error("fixture crashed");
  },
});
const inline = document.getElementById("inline")!;
const sidebar = document.getElementById("sidebar")!;
(window as any).previewPage = async (enabled: boolean) => {
  plane.preview(enabled ? sidebar : null);
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
};
let off: (() => void) | undefined;
const deadlines = new Set<() => void>();
let disposal = Promise.resolve();
const page = {
  key: "fixture",
  task: "fixture",
  visible: true,
  busy: () => controller?.isBusy() ?? false,
  running: () => Boolean(controller && controller.phase !== "disposed"),
  async suspend() {
    if (!(await controller.tryRecycle())) return false;
    disposal = controller.dispose();
    await disposal;
    plane.unmount(handle.sandboxId);
    manager.released(page);
    return true;
  },
  destroy() {
    void controller.dispose();
    plane.dispose();
    clearPluginUiWidgetState("fixture");
  },
};
const manager = new PluginUiPageManager<typeof page>(
  (run, ms) => {
    if (ms !== 300_000) throw new Error("unexpected retention deadline");
    deadlines.add(run);
    return () => {
      deadlines.delete(run);
    };
  },
  () => {},
);
async function start() {
  await manager.reserve(page);
  const config = await harness.config();
  controller = createPluginUiHostController({
    bridge: config
      ? (new Proxy(
          {},
          { get: (_, method) => (params: unknown) => harness.bridge(method, params) },
        ) as any)
      : ({
          prepareSandbox: () => harness.handle(),
          validateInstance: async () => {},
          closeInstance: async () => {},
          recycleInstance: async () => true,
        } as any),
    platform: {
      getOwnerWebContentsId: () => harness.owner(),
      disposeSandbox: (id, init) => harness.dispose(id, init),
      consumeUserGesture: async () => false,
      onPorts(handler) {
        portHandler = handler;
        return () => {
          if (portHandler === handler) portHandler = undefined;
        };
      },
    },
    scope: config?.scope ?? {
      workspacePath: "/fixture",
      sessionId: "fixture",
      scope: { kind: "surface", surfaceId: "fixture" },
    },
    presentation: config?.presentation ?? {
      pluginId: "fixture",
      serverName: "fixture",
      resourceUri: "ui://fixture",
    },
    createTransport: createPluginUiMessagePortTransport,
    initialHostContext: { displayMode: "inline" },
    hostVersion: "fixture",
    getToolFeed: () => ({}),
    getWidgetState: () => getPluginUiWidgetState("fixture"),
    getHostCapabilities: () => ({
      serverTools: {},
      serverResources: {},
      experimental: { "zcode/widgetState": {} },
    }),
    onUpdateWidgetState: async (value) => {
      setPluginUiWidgetState("fixture", value);
    },
    onPhase(phase, detail) {
      if (phase === "mounted") {
        handle = detail!.handle!;
        plane.mount(handle);
      }
      if (phase === "running") {
        handshakes++;
        ready.resolve();
      }
      if (phase === "error") ready.reject(new Error(detail?.error));
    },
    onHeight() {},
    onOpenExternal() {},
    onDisplayModeRequest: (mode) => mode,
  });
  controller.start();
  await ready.promise;
}
off = plane.bind({ node: inline, kind: "inline" });
void manager.add(page).then(start);
(window as any).switchPage = async (side: boolean) => {
  const started = performance.now();
  const previous = off;
  off = plane.bind({ node: side ? sidebar : inline, kind: side ? "sidebar" : "inline" });
  previous?.();
  controller.updateHostContext({ displayMode: side ? "fullscreen" : "inline" });
  const dispatchMs = performance.now() - started;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  return {
    handshakes,
    views: document.querySelectorAll("webview").length,
    listeners: [...tracked.values()].reduce((sum, items) => sum + items.size, 0),
    dispatchMs,
  };
};
(window as any).recyclePage = async () => {
  off?.();
  off = undefined;
  manager.visibility(page, false);
  // 可控期限触发生产 manager 的五分钟回收规则，不依赖实际等待五分钟。
  const completed = Promise.withResolvers<void>();
  const suspend = page.suspend;
  page.suspend = async () => {
    const result = await suspend();
    completed.resolve();
    return result;
  };
  for (const deadline of deadlines) deadline();
  deadlines.clear();
  await completed.promise;
  page.suspend = suspend;
  return {
    views: document.querySelectorAll("webview").length,
    state: getPluginUiWidgetState("fixture"),
  };
};
(window as any).restorePage = async (retry: boolean) => {
  if (retry) {
    clearPluginUiWidgetState("fixture");
    await page.suspend();
  }
  ready = Promise.withResolvers<void>();
  off = plane.bind({ node: inline, kind: "inline" });
  manager.visibility(page, true);
  await start();
  return { handshakes };
};
(window as any).disposePage = async () => {
  await controller.dispose();
  plane.unmount(handle.sandboxId);
  manager.released(page);
};
(window as any).currentHandle = () => handle;
(window as any).pageBusy = () => controller.isBusy();
(window as any).savedWidget = () => getPluginUiWidgetState("fixture");
(window as any).deliverFeed = (n: number) => {
  controller.notifyToolInput({ arguments: { sequence: n } });
  controller.notifyToolResult({ content: [], structuredContent: { sequence: n } });
};
