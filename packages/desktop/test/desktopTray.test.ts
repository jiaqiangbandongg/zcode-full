import type { MenuItemConstructorOptions } from "electron";
import { DesktopCommandIds, type Locale } from "@zcode/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[],
}));

vi.mock("electron", () => ({
  app: { isPackaged: false },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      captured.template = template;
      return { template };
    },
  },
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    on() {}
  },
}));

describe("desktop tray log export", () => {
  beforeEach(() => {
    vi.resetModules();
    captured.template = [];
  });

  it.each(["win32", "linux"] as const)(
    "%s replaces data deletion with localized log export and waits for the window",
    async (platform) => {
      const { createDesktopTray, updateWindowsDesktopTrayMenu } =
        await import("@desktop/main/desktopTray.js");
      let locale: Locale = "zh-CN";
      const windowReady = Promise.withResolvers<void>();
      const showCurrentWindow = vi.fn(() => windowReady.promise);
      const executeDesktopCommand = vi.fn(async () => undefined);
      createDesktopTray({
        platform,
        getLocale: () => locale,
        showCurrentWindow,
        executeDesktopCommand,
        quitApp: vi.fn(),
        logger: { warn: vi.fn() },
      });

      const labels = () => captured.template.map((item) => item.label).filter(Boolean);
      expect(labels()).not.toContain("清除所有数据");
      expect(labels().slice(-3)).toEqual(["关于 ZCode", "导出日志", "退出"]);
      locale = "en-US";
      updateWindowsDesktopTrayMenu();
      expect(labels()).not.toContain("Clear all data");
      expect(labels().slice(-3)).toEqual(["About ZCode", "Export logs", "Quit"]);

      const item = captured.template.find((entry) => entry.label === "Export logs");
      expect(item?.click).toBeDefined();
      // 模板回调不读取 Electron 事件参数；直接触发同一个原生菜单动作。
      (item!.click as () => void)();
      expect(showCurrentWindow).toHaveBeenCalledExactlyOnceWith();
      expect(executeDesktopCommand).not.toHaveBeenCalled();
      windowReady.resolve();
      await vi.waitFor(() =>
        expect(executeDesktopCommand).toHaveBeenCalledExactlyOnceWith(DesktopCommandIds.ExportLogs),
      );
    },
  );
});
