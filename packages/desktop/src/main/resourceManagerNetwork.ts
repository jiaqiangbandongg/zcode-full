import { randomUUID } from "node:crypto";
import { ipcMain, session, webContents, type BrowserWindow, type UtilityProcess } from "electron";
import { HostMessageTypes, PlatformChannels, type NetworkCaptureBatch } from "@zcode/shared";
import { createNodeNetworkCapture } from "@zcode/shared/node";
import { NetworkCaptureBuffer } from "./networkCaptureBuffer.js";
import { subscribeBeforeRequest } from "./observeBeforeRequest.js";

const buffer = new NetworkCaptureBuffer();
const nodeCapture = createNodeNetworkCapture("main", (batch) => buffer.ingest(batch));
let captureId: string | null = null;
let ownerId: number | null = null;
let currentHosts: (() => Iterable<UtilityProcess>) | null = null;
let disposers: Array<() => void> = [];

export function configureNetworkCaptureHost(child: UtilityProcess): void {
  if (!captureId) return;
  sendControl(child);
}

function sendControl(child: UtilityProcess): void {
  try {
    child.postMessage({ type: HostMessageTypes.NetworkCapture, control: { captureId } });
  } catch {
    /* Host 已退出，观测不重启进程 */
  }
}

export function startResourceManagerNetwork(
  senderId: number,
  hosts: () => Iterable<UtilityProcess>,
): void {
  if (captureId) return;
  captureId = randomUUID();
  ownerId = senderId;
  currentHosts = hosts;
  buffer.start(captureId);
  nodeCapture.setCaptureId(captureId);
  // 只订阅 App 拥有的 session；内置浏览器/录屏的独立 session 不进入采集。
  const sessions = [
    session.defaultSession,
    session.fromPartition("persist:zcode-coding-plan"),
    session.fromPartition("persist:zcode-rewards"),
  ];
  for (const appSession of sessions) {
    disposers.push(
      subscribeBeforeRequest(
        appSession.webRequest,
        ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"],
        (details) => {
          if (!captureId) return;
          const contents =
            details.webContents ??
            (details.webContentsId ? webContents.fromId(details.webContentsId) : null);
          if (contents?.isDestroyed() || contents?.getType() === "remote") return;
          buffer.ingest({
            captureId,
            dropped: 0,
            records: [
              {
                timestamp: Date.now(),
                processType: contents ? "renderer" : "main",
                pid: contents ? contents.getOSProcessId() : process.pid,
                method: details.method,
                url: details.url,
              },
            ],
          });
        },
      ),
    );
  }
  for (const host of hosts()) configureNetworkCaptureHost(host);
}

export function stopResourceManagerNetwork(hosts: Iterable<UtilityProcess>): void {
  if (!captureId) return;
  captureId = null;
  ownerId = null;
  currentHosts = null;
  nodeCapture.setCaptureId(null);
  for (const dispose of disposers) dispose();
  disposers = [];
  buffer.stop();
  for (const host of hosts) sendControl(host);
}

export function observeNetworkWindow(
  window: BrowserWindow,
  hosts: () => Iterable<UtilityProcess>,
): void {
  startResourceManagerNetwork(window.webContents.id, hosts);
  const stop = () => stopResourceManagerNetwork(hosts());
  window.on("closed", stop);
  window.webContents.on("render-process-gone", stop);
  window.webContents.on("destroyed", stop);
}

export function ingestHostNetworkCapture(batch: NetworkCaptureBatch, hostPid: number): void {
  buffer.ingest({
    ...batch,
    records: batch.records
      .filter((record) => record.processType === "host" || record.processType === "cli")
      .map((record) => (record.processType === "host" ? { ...record, pid: hostPid } : record)),
  });
}

export function registerResourceManagerNetworkIpc(): void {
  const authorize = (senderId: number) => {
    if (senderId !== ownerId || !captureId) throw new Error("Network capture is inactive");
  };
  ipcMain.handle(PlatformChannels.GetNetworkCaptureSnapshot, (event) => {
    authorize(event.sender.id);
    return buffer.snapshot();
  });
  ipcMain.handle(PlatformChannels.ClearNetworkCapture, (event) => {
    authorize(event.sender.id);
    // 清空需要切换 captureId，否则 Host/CLI 尚未发出的旧批次会把列表填回来。
    captureId = randomUUID();
    buffer.start(captureId);
    nodeCapture.setCaptureId(captureId);
    for (const host of currentHosts?.() ?? []) configureNetworkCaptureHost(host);
  });
}
