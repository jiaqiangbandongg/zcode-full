import { describe, expect, it, vi } from "vitest";
import {
  applyEarlyChromiumHardwareAccelerationBootstrap,
  extractBootstrapChromiumHardwareAccelerationEnabled,
} from "../src/main/desktopChromiumHardwareAccelerationBootstrap.js";

describe("desktopChromiumHardwareAccelerationBootstrap", () => {
  it("默认开启 Chromium 硬件加速，仅显式 false 关闭", () => {
    expect(extractBootstrapChromiumHardwareAccelerationEnabled(null)).toBe(true);
    expect(extractBootstrapChromiumHardwareAccelerationEnabled({})).toBe(true);
    expect(
      extractBootstrapChromiumHardwareAccelerationEnabled({
        desktopChromiumHardwareAccelerationEnabled: true,
      }),
    ).toBe(true);
    expect(
      extractBootstrapChromiumHardwareAccelerationEnabled({
        desktopChromiumHardwareAccelerationEnabled: false,
      }),
    ).toBe(false);
    expect(
      extractBootstrapChromiumHardwareAccelerationEnabled({
        desktopChromiumHardwareAccelerationEnabled: "false",
      }),
    ).toBe(true);
  });

  it("只在设置显式关闭时调用 Electron disableHardwareAcceleration", () => {
    const disableHardwareAcceleration = vi.fn();

    expect(
      applyEarlyChromiumHardwareAccelerationBootstrap(
        { disableHardwareAcceleration },
        { desktopChromiumHardwareAccelerationEnabled: true },
      ),
    ).toBe(true);
    expect(disableHardwareAcceleration).not.toHaveBeenCalled();

    expect(
      applyEarlyChromiumHardwareAccelerationBootstrap(
        { disableHardwareAcceleration },
        { desktopChromiumHardwareAccelerationEnabled: false },
      ),
    ).toBe(false);
    expect(disableHardwareAcceleration).toHaveBeenCalledTimes(1);
  });
});
