import { describe, expect, it, vi } from "vitest";
import {
  maxWindowUnreadCounts,
  parseWindowUnreadCount,
  resolveBadgeOverlayLabel,
  supportsAppUnreadBadge,
  syncUnreadBadgeForPlatform,
} from "../src/main/unreadBadge.js";

describe("unread badge", () => {
  it("只接受非负整数的窗口未读数上报", () => {
    expect(parseWindowUnreadCount(0)).toBe(0);
    expect(parseWindowUnreadCount(3)).toBe(3);
    expect(parseWindowUnreadCount(-1)).toBeNull();
    expect(parseWindowUnreadCount(1.5)).toBeNull();
    expect(parseWindowUnreadCount("2")).toBeNull();
  });

  it("多窗口上报同一全局计数，聚合取 max 防止多主窗口翻倍", () => {
    expect(
      maxWindowUnreadCounts(
        new Map([
          [1, 3],
          [2, 3],
          [3, 0],
        ]),
      ),
    ).toBe(3);
    expect(maxWindowUnreadCounts(new Map())).toBe(0);
  });

  it("只在 macOS / Linux 启用应用级 badge", () => {
    expect(supportsAppUnreadBadge("darwin")).toBe(true);
    expect(supportsAppUnreadBadge("linux")).toBe(true);
    expect(supportsAppUnreadBadge("win32")).toBe(false);
  });

  it("角标 overlay 文案：0 清除、1~9 原样、10 以上折叠为 9+", () => {
    expect(resolveBadgeOverlayLabel(0)).toBeNull();
    expect(resolveBadgeOverlayLabel(7)).toBe("7");
    expect(resolveBadgeOverlayLabel(9)).toBe("9");
    expect(resolveBadgeOverlayLabel(10)).toBe("9+");
    expect(resolveBadgeOverlayLabel(999)).toBe("9+");
    expect(resolveBadgeOverlayLabel(-3)).toBeNull();
  });

  it("平台分叉：macOS/Linux 写 app badge，不碰 overlay", () => {
    const setBadgeCount = vi.fn();
    const applyOverlay = vi.fn();

    syncUnreadBadgeForPlatform({
      platform: "darwin",
      totalUnreadCount: 4,
      setBadgeCount,
      applyOverlay,
    });

    expect(setBadgeCount).toHaveBeenCalledWith(4);
    expect(applyOverlay).not.toHaveBeenCalled();
  });

  it("平台分叉：Windows 写 overlay 文案，不碰 app badge", () => {
    const setBadgeCount = vi.fn();
    const applyOverlay = vi.fn();

    syncUnreadBadgeForPlatform({
      platform: "win32",
      totalUnreadCount: 3,
      setBadgeCount,
      applyOverlay,
    });

    expect(applyOverlay).toHaveBeenCalledWith("3");
    expect(setBadgeCount).not.toHaveBeenCalled();
  });

  it("Windows 未读归零时下发 null 以移除 overlay", () => {
    const applyOverlay = vi.fn();

    syncUnreadBadgeForPlatform({
      platform: "win32",
      totalUnreadCount: 0,
      setBadgeCount: vi.fn(),
      applyOverlay,
    });

    expect(applyOverlay).toHaveBeenCalledWith(null);
  });
});
