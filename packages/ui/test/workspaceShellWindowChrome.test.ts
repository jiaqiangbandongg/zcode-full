import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceShellPanelRadiusPx,
  resolveWorkspaceShellResizeHandleInsetPx,
  resolveWorkspaceShellWindowChromeClass,
} from "../src/app-shell/workspaceShellWindowChrome.js";

describe("resolveWorkspaceShellWindowChromeClass", () => {
  it("uses 6px corners on macOS Sequoia and earlier", () => {
    expect(
      resolveWorkspaceShellWindowChromeClass({
        isMacDesktop: true,
        macOSMajorVersion: 15,
        isWindowsDesktop: false,
        isWindowsMaximized: false,
        supportsNativeRoundedCorners: false,
      }),
    ).toBe("rounded-[6px] border border-border");
  });

  it("uses 12px corners on macOS Tahoe and later", () => {
    expect(
      resolveWorkspaceShellWindowChromeClass({
        isMacDesktop: true,
        macOSMajorVersion: 26,
        isWindowsDesktop: false,
        isWindowsMaximized: false,
        supportsNativeRoundedCorners: false,
      }),
    ).toBe("rounded-xl border border-border");
  });

  it("uses 5px corners in Windows 11 normal windows", () => {
    expect(
      resolveWorkspaceShellWindowChromeClass({
        isWindowsDesktop: true,
        isWindowsMaximized: false,
        supportsNativeRoundedCorners: true,
      }),
    ).toBe("rounded-[5px] border border-border");
  });

  it("keeps the inset panel rounded and fully bordered when Windows 11 is maximized", () => {
    expect(
      resolveWorkspaceShellWindowChromeClass({
        isWindowsDesktop: true,
        isWindowsMaximized: true,
        supportsNativeRoundedCorners: true,
      }),
    ).toBe("rounded-[5px] border border-border");
  });

  it("squares only the outer corners and preserves the full border on Windows 10", () => {
    expect(
      resolveWorkspaceShellWindowChromeClass({
        isWindowsDesktop: true,
        isWindowsMaximized: false,
        supportsNativeRoundedCorners: false,
      }),
    ).toBe("rounded-l-[5px] border border-border");
    expect(
      resolveWorkspaceShellWindowChromeClass({
        isWindowsDesktop: true,
        isWindowsMaximized: true,
        supportsNativeRoundedCorners: false,
      }),
    ).toBe("rounded-l-[5px] border border-border");
  });

  it("preserves the existing appearance while Windows capability is unknown", () => {
    expect(
      resolveWorkspaceShellWindowChromeClass({
        isWindowsDesktop: true,
        isWindowsMaximized: false,
        supportsNativeRoundedCorners: null,
      }),
    ).toBe("rounded-[5px] border border-border");
  });
});

it.each([false, true])(
  "matches the settings xl Linux corners when maximized=%s",
  (isWindowsMaximized) => {
    expect(
      resolveWorkspaceShellWindowChromeClass({
        isLinuxDesktop: true,
        isWindowsDesktop: false,
        isWindowsMaximized,
        supportsNativeRoundedCorners: false,
      }),
    ).toBe("rounded-xl border border-border");
  },
);

describe("workspace shell resize handle inset", () => {
  it.each([
    ["macOS Sequoia", { isMacDesktop: true, macOSMajorVersion: 15 }, 6, 10],
    ["unknown macOS", { isMacDesktop: true, macOSMajorVersion: null }, 6, 10],
    ["macOS Sonoma", { isMacDesktop: true, macOSMajorVersion: 14 }, 6, 10],
    ["Web", {}, 12, 16],
    ["macOS Tahoe", { isMacDesktop: true, macOSMajorVersion: 26 }, 12, 16],
    ["Windows", { isWindowsDesktop: true }, 5, 9],
    ["Linux", { isLinuxDesktop: true }, 12, 16],
  ] as const)(
    "aligns %s handle with the start of the straight edge",
    (_name, platform, radius, inset) => {
      expect(resolveWorkspaceShellPanelRadiusPx(platform)).toBe(radius);
      expect(resolveWorkspaceShellResizeHandleInsetPx(platform)).toBe(inset);
    },
  );
});
