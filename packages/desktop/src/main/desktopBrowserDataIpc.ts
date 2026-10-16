import { ipcMain } from "electron";
import {
  PlatformChannels,
  type ChromeBrowserDataImportOptions,
  type EmbeddedBrowserSitePermissionUpdateRequest,
} from "@zcode/shared";
import {
  clearEmbeddedBrowserData,
  importChromeBrowserData,
} from "./browserDataManager.js";
import {
  clearEmbeddedBrowserSitePermissions,
  getEmbeddedBrowserSitePermissionSnapshot,
  removeEmbeddedBrowserSitePermission,
  removeEmbeddedBrowserSitePermissionOrigin,
  writeEmbeddedBrowserSitePermission,
} from "./embeddedBrowserSitePermissions.js";

export function registerBrowserDataIpcHandlers(logger: {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}) {
  ipcMain.handle(PlatformChannels.ImportChromeBrowserData, (_event, value: unknown) => {
    const requested = value as ChromeBrowserDataImportOptions | undefined;
    // renderer 只能为本次调用显式传 true；main 不接受或持久化其他授权形态。
    const allowElevatedChromeDecryption = requested?.allowElevatedChromeDecryption === true;
    return importChromeBrowserData({ allowElevatedChromeDecryption, logger });
  });
  ipcMain.handle(PlatformChannels.ClearEmbeddedBrowserData, (_event, mode: unknown) => {
    if (mode !== "cache" && mode !== "all") {
      return { success: false, error: "invalid_clear_mode" };
    }
    return clearEmbeddedBrowserData({ logger, mode });
  });
  ipcMain.handle(PlatformChannels.GetEmbeddedBrowserSitePermissions, () =>
    getEmbeddedBrowserSitePermissionSnapshot(),
  );
  ipcMain.handle(PlatformChannels.SetEmbeddedBrowserSitePermission, (_event, value: unknown) => {
    const request = value as EmbeddedBrowserSitePermissionUpdateRequest | undefined;
    if (
      !request ||
      typeof request.origin !== "string" ||
      !request.origin ||
      typeof request.permission !== "string" ||
      !request.permission ||
      (request.state !== "allow" && request.state !== "deny" && request.state !== "ask")
    ) {
      logger.warn("[browser-data] ignored malformed site permission update");
      return getEmbeddedBrowserSitePermissionSnapshot();
    }
    if (request.state === "ask") {
      void removeEmbeddedBrowserSitePermission(request.origin, request.permission);
    } else {
      void writeEmbeddedBrowserSitePermission(request.origin, request.permission, request.state);
    }
    logger.info("[embedded-browser-permission] site permission updated from settings", {
      origin: request.origin,
      permission: request.permission,
      state: request.state,
    });
    return getEmbeddedBrowserSitePermissionSnapshot();
  });
  ipcMain.handle(PlatformChannels.ClearEmbeddedBrowserSitePermissions, () => {
    void clearEmbeddedBrowserSitePermissions();
    logger.info("[embedded-browser-permission] site permissions cleared from settings");
    return getEmbeddedBrowserSitePermissionSnapshot();
  });
  ipcMain.handle(PlatformChannels.ResetEmbeddedBrowserSitePermission, (_event, value: unknown) => {
    const request = value as { origin?: unknown } | undefined;
    if (!request || typeof request.origin !== "string" || !request.origin) {
      logger.warn("[browser-data] ignored malformed site permission reset");
      return getEmbeddedBrowserSitePermissionSnapshot();
    }
    void removeEmbeddedBrowserSitePermissionOrigin(request.origin);
    logger.info("[embedded-browser-permission] site permissions reset from settings tab", {
      origin: request.origin,
    });
    return getEmbeddedBrowserSitePermissionSnapshot();
  });
}
