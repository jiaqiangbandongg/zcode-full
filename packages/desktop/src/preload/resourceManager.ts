import { contextBridge, ipcRenderer } from "electron";
import { PlatformChannels, formatZCodeRendererProcessName } from "@zcode/shared";
import type {
  ResourceUsageSnapshot,
  NetworkCaptureBridge,
  StorageCleanRequest,
  StorageCleanResult,
  StorageManagementBridge,
  StorageUsageSnapshot,
} from "@zcode/shared";

process.title = formatZCodeRendererProcessName("Resource Manager");

const storage: StorageManagementBridge = {
  startScan: (): Promise<{ jobId: string }> =>
    ipcRenderer.invoke(PlatformChannels.StorageStartScan),
  cancelScan: (jobId: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.StorageCancelScan, jobId),
  getSnapshot: (): Promise<StorageUsageSnapshot | null> =>
    ipcRenderer.invoke(PlatformChannels.StorageGetSnapshot),
  clean: (request: StorageCleanRequest): Promise<StorageCleanResult> =>
    ipcRenderer.invoke(PlatformChannels.StorageClean, request),
  revealPath: (absolutePath: string): Promise<void> =>
    ipcRenderer.invoke(PlatformChannels.StorageRevealPath, absolutePath),
  subscribeScanProgress: (listener) => {
    const handler = (_event: unknown, snapshot: StorageUsageSnapshot) => listener(snapshot);
    ipcRenderer.on(PlatformChannels.StorageScanProgress, handler);
    return () => ipcRenderer.removeListener(PlatformChannels.StorageScanProgress, handler);
  },
};

const network: NetworkCaptureBridge = {
  getSnapshot: () => ipcRenderer.invoke(PlatformChannels.GetNetworkCaptureSnapshot),
  clear: () => ipcRenderer.invoke(PlatformChannels.ClearNetworkCapture),
};

/**
 * 资源管理器窗口专用 preload —— 资源快照拉取 + 存储管理命令面。
 * 不需要 MessagePort 转发，因为资源管理器窗口不使用 RPC 服务，也不接入桌面 continuous 主链路；
 * 存储服务由 main 持有，这里只是 ipc 桥。
 */
contextBridge.exposeInMainWorld("resourceManager", {
  setSamplingActive: (active: boolean): void =>
    ipcRenderer.send(PlatformChannels.SetResourceUsageSamplingActive, active),
  getSnapshot: (): Promise<ResourceUsageSnapshot> =>
    ipcRenderer.invoke(PlatformChannels.GetResourceUsageSnapshot),
  storage,
  network,
});
