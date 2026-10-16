import { PlatformChannels, type WebRemoteControlStatus } from "@zcode/shared";

interface WebRemoteControlStatusEventTarget {
  isDestroyed(): boolean;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, status: WebRemoteControlStatus): void;
  };
}

export function sendWebRemoteControlStatusChangedToWindow(
  targetWindow: WebRemoteControlStatusEventTarget | null | undefined,
  status: WebRemoteControlStatus,
): void {
  if (
    !targetWindow ||
    targetWindow.isDestroyed() ||
    targetWindow.webContents.isDestroyed()
  ) {
    return;
  }

  // Bugfix: Web 远控状态变化是异步推送，窗口关闭过程中 BrowserWindow 可能还存在，
  // 但 webContents 已销毁。发送前同时校验两层对象，避免退出/刷新时 IPC send 抛错。
  targetWindow.webContents.send(PlatformChannels.WebRemoteControlStatusChanged, status);
}
