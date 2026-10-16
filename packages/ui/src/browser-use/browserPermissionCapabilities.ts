/**
 * 站点权限设置标签页的能力目录（key = main 持久层的 permission 字符串，
 * 与 embeddedBrowserPermissionPolicy 的 PROMPT_PERMISSIONS 对齐）。
 * label 走 i18n；iconKey 复用 BrowserPermissionIcon 的能力字形。
 */
export interface BrowserPermissionCapability {
  key: string;
  labelId: string;
  iconKey: string;
}

export const BROWSER_PERMISSION_CAPABILITIES: readonly BrowserPermissionCapability[] = [
  { key: "media", labelId: "browser.permission.media", iconKey: "camera" },
  { key: "clipboard-read", labelId: "browser.permission.clipboardRead", iconKey: "clipboard-read" },
  { key: "geolocation", labelId: "browser.permission.geolocation", iconKey: "geolocation" },
  { key: "notifications", labelId: "browser.permission.notifications", iconKey: "notifications" },
  { key: "midi", labelId: "browser.permission.midi", iconKey: "midi" },
  { key: "midiSysex", labelId: "browser.permission.midi", iconKey: "midi" },
  { key: "idle-detection", labelId: "browser.permission.idleDetection", iconKey: "idle-detection" },
  {
    key: "speaker-selection",
    labelId: "browser.permission.speakerSelection",
    iconKey: "speaker-selection",
  },
  {
    key: "window-management",
    labelId: "browser.permission.windowManagement",
    iconKey: "window-management",
  },
  { key: "storage-access", labelId: "browser.permission.storageAccess", iconKey: "storage-access" },
  {
    key: "top-level-storage-access",
    labelId: "browser.permission.storageAccess",
    iconKey: "storage-access",
  },
  { key: "keyboardLock", labelId: "browser.permission.keyboardLock", iconKey: "keyboardLock" },
  { key: "fileSystem", labelId: "browser.permission.fileSystem", iconKey: "fileSystem" },
];
