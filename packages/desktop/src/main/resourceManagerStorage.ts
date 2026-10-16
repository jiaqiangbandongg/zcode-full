/**
 * 资源管理器「存储」tab 的 main 侧接线：main 持有唯一的 StorageService 实例（Worker 线程遍历），
 * 通过 ipc invoke 暴露命令面，进度快照推给发起请求的资源管理器窗口；窗口关闭即取消扫描。
 * 之所以放在 main 而不是 Window Host：该窗口按设计不接 RPC（见 preload/resourceManager.ts），
 * 而扫盘只是 fs 遍历，跑在 worker_threads 里不会阻塞 main 事件循环。
 */
import { BrowserWindow, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { PlatformChannels, type StorageCleanRequest, type StorageRootSpec } from "@zcode/shared";
import {
  createFsStorageCleaner,
  createStorageRootsResolver,
  createStorageService,
  getDataBaseDir,
  type IStorageService,
} from "@zcode/services/node";
import { logger } from "./logger.js";
import { createStorageScanWorkerRunner } from "./storageScanWorkerClient.js";

let service: IStorageService | null = null;
let latestJobId: string | null = null;
let subscriber: WebContents | null = null;
const rootsResolver = createStorageRootsResolver({ getHomeDir: homedir, getDataBaseDir });

function getService(): IStorageService {
  if (service) return service;
  service = createStorageService({
    roots: rootsResolver,
    scanRunner: createStorageScanWorkerRunner(),
    cleaner: createFsStorageCleaner(),
  });
  service.onScanProgress((snapshot) => {
    if (subscriber && !subscriber.isDestroyed()) {
      subscriber.send(PlatformChannels.StorageScanProgress, snapshot);
    }
  });
  return service;
}

/** 只有资源管理器窗口能发起存储命令；窗口关闭时取消进行中的扫描，避免后台空转。 */
function bindSubscriber(event: IpcMainInvokeEvent): void {
  if (subscriber === event.sender) return;
  subscriber = event.sender;
  const win = BrowserWindow.fromWebContents(event.sender);
  win?.once("closed", () => {
    if (subscriber !== event.sender) return;
    subscriber = null;
    if (latestJobId && service) {
      void service.cancelScan(latestJobId);
      latestJobId = null;
    }
  });
}

/** 纯函数：定位路径必须落在某个数据根内，防止 renderer 传任意路径让系统文件管理器打开。 */
export function isPathInsideStorageRoots(absolutePath: string, roots: StorageRootSpec[]): boolean {
  const target = resolve(absolutePath);
  return roots.some((root) => {
    const back = relative(resolve(root.path), target);
    return back === "" || (!back.startsWith("..") && !isAbsolute(back));
  });
}

export function registerResourceManagerStorageIpc(): void {
  ipcMain.handle(PlatformChannels.StorageStartScan, async (event) => {
    bindSubscriber(event);
    const result = await getService().startScan();
    latestJobId = result.jobId;
    return result;
  });
  ipcMain.handle(PlatformChannels.StorageCancelScan, async (_event, jobId: string) => {
    if (!service) return;
    await service.cancelScan(jobId);
    if (latestJobId === jobId) latestJobId = null;
  });
  ipcMain.handle(PlatformChannels.StorageGetSnapshot, async () =>
    service ? service.getSnapshot() : null,
  );
  ipcMain.handle(PlatformChannels.StorageClean, async (event, request: StorageCleanRequest) => {
    bindSubscriber(event);
    return getService().clean(request);
  });
  ipcMain.handle(PlatformChannels.StorageRevealPath, async (_event, absolutePath: string) => {
    const roots = await rootsResolver.resolveRoots();
    if (typeof absolutePath !== "string" || !isPathInsideStorageRoots(absolutePath, roots)) {
      logger.warn("[resource-manager] refused to reveal path outside storage roots", {
        absolutePath,
      });
      return;
    }
    shell.showItemInFolder(absolutePath);
  });
}
