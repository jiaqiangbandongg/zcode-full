import { BrowserWindow, ipcMain } from "electron";
import {
  PlatformChannels,
  WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
  webRemoteControlReconnectWorkspaceResultSchema,
  type WebRemoteControlReconnectWorkspaceRequest,
} from "@zcode/shared";

export function reconnectWebRemoteControlWorkspaceInRenderer(
  windowId: number,
  workspaceKey: string,
): Promise<void> {
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) {
    throw new Error("Desktop window is not available for Web remote control reconnect.");
  }

  const request: WebRemoteControlReconnectWorkspaceRequest = {
    requestId: `web-remote-reconnect-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceKey,
  };

  return new Promise((resolve, reject) => {
    const dispose = () => {
      clearTimeout(timeout);
      ipcMain.removeListener(PlatformChannels.WebRemoteControlReconnectWorkspace, handleResult);
    };
    const timeout = setTimeout(() => {
      dispose();
      reject(new Error("Web remote control reconnect request timed out."));
    }, WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS);

    const handleResult = (event: Electron.IpcMainEvent, payload: unknown) => {
      if (event.sender.id !== win.webContents.id) {
        return;
      }
      const result = webRemoteControlReconnectWorkspaceResultSchema.safeParse(payload);
      if (!result.success || result.data.requestId !== request.requestId) {
        return;
      }

      dispose();
      if (result.data.success) {
        resolve();
        return;
      }
      reject(new Error(result.data.error));
    };

    ipcMain.on(PlatformChannels.WebRemoteControlReconnectWorkspace, handleResult);
    win.webContents.send(PlatformChannels.WebRemoteControlReconnectWorkspace, request);
  });
}
