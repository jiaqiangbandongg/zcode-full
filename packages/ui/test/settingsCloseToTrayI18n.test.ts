import { describe, expect, it } from "vitest";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

// Linux 关闭驻留托盘文案（spec：docs/desktop/linux-close-to-tray.md）。
// 置灰描述必须说明"为什么不可用"，GNOME 追加扩展安装提示，避免用户把置灰当成 bug。
describe("settings close-to-tray i18n", () => {
  it("中英文案 key 成对存在", () => {
    expect(zhCN["settings.closeToTrayUnavailable"]).toContain("未提供系统托盘");
    expect(enUS["settings.closeToTrayUnavailable"]).toContain("no system tray");
    expect(zhCN["settings.closeToTrayGnomeHint"]).toContain("AppIndicator");
    expect(enUS["settings.closeToTrayGnomeHint"]).toContain("AppIndicator");
  });

  it("设置描述不再限定仅 Windows 生效", () => {
    // 语义已扩展到 Linux（按托盘能力自适应），描述里不得再出现"仅 Windows"。
    expect(zhCN["settings.closeToTrayOnWindowsDescription"]).not.toContain("仅 Windows");
    expect(enUS["settings.closeToTrayOnWindowsDescription"]).not.toContain("Windows only");
  });

  it("Linux 可用性描述以桌面环境为主语，避免被误读为 Linux 系统本身不支持", () => {
    // 歧义复盘：曾写作"Linux 需系统托盘支持"，读起来像 Linux 系统缺能力；
    // 实际语义是桌面环境是否提供托盘决定可用性（KDE/XFCE 可以，GNOME 默认没有）。
    expect(zhCN["settings.closeToTrayOnWindowsDescription"]).toContain(
      "取决于桌面环境是否提供系统托盘",
    );
    expect(enUS["settings.closeToTrayOnWindowsDescription"]).toContain(
      "depends on whether the desktop environment provides a system tray",
    );
  });
});
