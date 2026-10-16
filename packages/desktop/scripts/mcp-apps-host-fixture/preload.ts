import { PlatformChannels } from "@zcode/shared";
import { contextBridge, ipcRenderer } from "electron";
import { installPluginSandboxHostBridge } from "../../src/preload/pluginSandbox/hostBridge.js";
installPluginSandboxHostBridge();
contextBridge.exposeInMainWorld("harness", {
  handle: () => ipcRenderer.invoke("fixture-handle"),
  config: () => ipcRenderer.invoke("fixture-config"),
  bridge: (method: string, params: unknown) => ipcRenderer.invoke("fixture-bridge", method, params),
  appTools: (method: string, params: unknown) =>
    ipcRenderer.invoke("fixture-app-tools", method, params),
  v4: (method: string, params: unknown) => ipcRenderer.invoke("fixture-v4", method, params),
  event: (value: unknown) => ipcRenderer.invoke("fixture-event", value),
  owner: () => ipcRenderer.invoke(PlatformChannels.PluginSandboxOwnerWebContentsId),
  dispose: (id: string, generation: number) =>
    ipcRenderer.invoke(PlatformChannels.PluginSandboxDispose, id, generation),
});
ipcRenderer.on("fixture-notification", (_event, payload) =>
  window.postMessage({ type: "fixture-notification", payload }, "*"),
);
