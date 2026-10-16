import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels } from "@zcode/shared";
import { installPluginSandboxHostBridge } from "../../src/preload/pluginSandbox/hostBridge.js";
installPluginSandboxHostBridge();
contextBridge.exposeInMainWorld("harness", {
  config: () => ipcRenderer.invoke("fixture-config"),
  bridge: (method: string, input: unknown) => ipcRenderer.invoke("fixture-service", method, input),
  owner: () => ipcRenderer.invoke(PlatformChannels.PluginSandboxOwnerWebContentsId),
  dispose: (id: string, init: number) =>
    ipcRenderer.invoke(PlatformChannels.PluginSandboxDispose, id, init),
  gesture: () => ipcRenderer.invoke("fixture-gesture"),
});
ipcRenderer.on("fixture-state", (_, payload) =>
  window.postMessage({ type: "fixture-notification", payload }, "*"),
);
