import { ipcRenderer } from "electron";
import { PluginSandboxChannels } from "@zcode/shared";

/**
 * 插件 UI 沙箱 guest 的 preload。只做一件事：把 main 送来的那条 MessagePort 经 window.postMessage
 * 原样转交给受信 relay shell（contextBridge 会把 MessagePort 包成 Proxy，丢失原生方法，与 preload/index.ts 同一原因）。
 * 不暴露任何 contextBridge API；插件 iframe 在 shell 内的子 frame 里，且 nodeIntegrationInSubFrames=false，
 * 因此这段代码只在 shell 顶层 frame 运行。
 */
const PLUGIN_SANDBOX_SCHEME = "zcode-sandbox:";

if (window.location.protocol === PLUGIN_SANDBOX_SCHEME && window.top === window) {
  ipcRenderer.on(
    PluginSandboxChannels.Init,
    (event, payload: { sandboxId?: unknown; initId?: unknown; allow?: unknown }) => {
      if (
        typeof payload?.sandboxId !== "string" ||
        typeof payload?.initId !== "number" ||
        event.ports.length !== 1
      ) {
        return;
      }
      window.postMessage(
        {
          type: "init",
          sandboxId: payload.sandboxId,
          initId: payload.initId,
          ...(typeof payload.allow === "string" ? { allow: payload.allow } : {}),
        },
        window.location.origin,
        event.ports,
      );
    },
  );
}
