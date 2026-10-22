import { BrowserWindow, ipcMain } from "electron";
import { DesktopCommandIds, PlatformChannels, type DesktopCommandId } from "@zcode/shared";

export function registerDesktopCommandIpcHandler(options: {
  executeDesktopCommand: (
    command: DesktopCommandId,
    senderWindow?: BrowserWindow | null,
  ) => Promise<unknown>;
  logger: {
    warn: (...args: unknown[]) => void;
  };
}): void {
  ipcMain.handle(PlatformChannels.ExecuteDesktopCommand, async (event, command: string) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    const isKnownCommand = (Object.values(DesktopCommandIds) as string[]).includes(command);
    if (!isKnownCommand) {
      options.logger.warn("[desktop-command] invalid command:", command);
      return;
    }

    // Bugfix: 返回值必须直通 renderer，GetCuaOsSupport 才能拿到主进程的支持态。
    return options.executeDesktopCommand(command as DesktopCommandId, senderWindow);
  });
}
