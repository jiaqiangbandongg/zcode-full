import {
  createPluginUiHostController,
  type PluginUiHostController,
} from "../../../ui/src/plugin-ui/app/pluginUiHostController.js";
import { PluginUiPageManager } from "../../../ui/src/plugin-ui/app/pluginUiPageManager.js";
import { createPluginUiMessagePortTransport } from "../../../ui/src/plugin-ui/adapters/messagePortTransport.js";
import { createPluginUiPagePlane } from "../../../ui/src/plugin-ui/adapters/pluginUiPagePlane.js";
import type { PluginSandboxHandle, PluginSandboxPortsEvent } from "@zcode/shared/mcp-apps";
const harness = (window as any).harness;
const ports = new Set<(event: PluginSandboxPortsEvent) => void>();
window.addEventListener("message", (event) => {
  if (event.data?.type === "zcode:plugin-sandbox-ports" && event.ports.length === 1)
    for (const receive of ports) receive({ ...event.data, port: event.ports[0] });
});
let now = 0;
const timers = new Map<() => void, number>();
const snapshots = new Map<string, unknown>();
const pending = new Set<Promise<unknown>>();
const released: string[] = [];
const track = (promise: Promise<unknown>) => {
  pending.add(promise);
  void promise.then(
    () => pending.delete(promise),
    () => pending.delete(promise),
  );
  return promise;
};
const owner = new PluginUiPageManager<Page>(
  (run, ms) => {
    timers.set(run, now + ms);
    return () => {
      timers.delete(run);
    };
  },
  (task) => {
    for (const key of snapshots.keys()) if (key.startsWith(task + "/")) snapshots.delete(key);
  },
);
type Page = {
  key: string;
  task: string;
  visible: boolean;
  busy(): boolean;
  running(): boolean;
  suspend(): Promise<boolean>;
  destroy(): void;
  setBusy(value: boolean): void;
  handle?: PluginSandboxHandle;
};
const pages = new Map<string, Page>();
async function addPage(key: string, task: string, visible = true) {
  let busy = false;
  let running = false;
  let controller: PluginUiHostController;
  let handle: PluginSandboxHandle | undefined;
  const anchor = document.createElement("div");
  anchor.style.cssText = `position:absolute;left:${(pages.size % 8) * 120}px;top:${Math.floor(pages.size / 8) * 95}px;width:115px;height:90px;`;
  document.body.append(anchor);
  const plane = createPluginUiPagePlane({
    onVisibility() {},
    onCrash() {
      throw Error("retention guest crashed");
    },
  });
  const off = plane.bind({ node: anchor, kind: "inline" });
  const page: Page = {
    key,
    task,
    visible,
    busy: () => busy,
    running: () => running,
    setBusy(value) {
      busy = value;
      owner.settled(page);
    },
    suspend() {
      const result = (async () => {
        if (!running) return true;
        if (busy) return false;
        running = false;
        await controller.dispose();
        plane.unmount(handle!.sandboxId);
        owner.released(page);
        released.push(key);
        return true;
      })();
      track(result);
      return result;
    },
    destroy() {
      busy = false;
      track(
        page.suspend().then(() => {
          plane.dispose();
          off();
          anchor.remove();
          pages.delete(key);
        }),
      );
    },
  };
  await owner.add(page);
  pages.set(key, page);
  try {
    await owner.reserve(page);
  } catch (error) {
    plane.dispose();
    off();
    anchor.remove();
    return { error: String(error) };
  }
  const ready = Promise.withResolvers<void>();
  controller = createPluginUiHostController({
    scope: {
      workspacePath: "/retention",
      sessionId: task,
      scope: { kind: "surface", surfaceId: key },
    },
    presentation: { pluginId: "fixture", serverName: "fixture", resourceUri: "ui://fixture" },
    bridge: {
      prepareSandbox: () => harness.bridge("register", { key, task }),
      validateInstance: async () => {},
      closeInstance: async () => {},
      recycleInstance: async () => !busy,
    } as any,
    platform: {
      getOwnerWebContentsId: () => harness.owner(),
      disposeSandbox: (id, init) => harness.dispose(id, init),
      consumeUserGesture: async () => false,
      onPorts(receive) {
        ports.add(receive);
        return () => {
          ports.delete(receive);
        };
      },
    },
    createTransport: createPluginUiMessagePortTransport,
    initialHostContext: { displayMode: "inline" },
    hostVersion: "fixture",
    getToolFeed: () => ({}),
    getWidgetState: () => snapshots.get(task + "/" + key),
    getHostCapabilities: () => ({}),
    onPhase(phase, detail) {
      if (phase === "mounted") {
        handle = detail!.handle!;
        page.handle = handle;
        plane.mount(handle);
      }
      if (phase === "running") {
        running = true;
        ready.resolve();
      }
      if (phase === "error") ready.reject(Error(detail?.error));
    },
    onHeight() {},
    onOpenExternal() {},
    onDisplayModeRequest: (mode) => mode,
  });
  controller.start();
  await ready.promise;
  snapshots.set(task + "/" + key, { saved: key });
  return { sandboxId: handle!.sandboxId };
}
async function drain() {
  while (pending.size) await Promise.all(pending);
}
(window as any).retention = {
  addPage,
  counts: () => ({
    pages: pages.size,
    views: document.querySelectorAll("webview").length,
    ports: ports.size,
    snapshots: snapshots.size,
    timers: timers.size,
    released: [...released],
  }),
  visibility: (key: string, value: boolean) => owner.visibility(pages.get(key)!, value),
  busy: (key: string, value: boolean) => pages.get(key)!.setBusy(value),
  async advance(ms: number) {
    now += ms;
    for (const [run, deadline] of timers)
      if (deadline <= now) {
        timers.delete(run);
        run();
      }
    await drain();
  },
  async clear() {
    owner.clear();
    await drain();
  },
};
(window as any).harnessReady = Promise.resolve();
