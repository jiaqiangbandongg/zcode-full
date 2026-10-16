import { describe, expect, it } from "vitest";
import {
  resolveDesktopWindowChromeState,
  supportsNativeWindowsRoundedCorners,
} from "../src/main/desktopWindowChromeState.js";

describe("supportsNativeWindowsRoundedCorners", () => {
  it("uses Windows build 22000 as the native rounded-corner boundary", () => {
    expect(supportsNativeWindowsRoundedCorners("win32", "10.0.21999")).toBe(false);
    expect(supportsNativeWindowsRoundedCorners("win32", "10.0.22000")).toBe(true);
    expect(supportsNativeWindowsRoundedCorners("win32", "10.0.26100")).toBe(true);
  });

  it("returns false for legacy, malformed, and non-Windows releases", () => {
    expect(supportsNativeWindowsRoundedCorners("win32", "6.3.9600")).toBe(false);
    expect(supportsNativeWindowsRoundedCorners("win32", "unknown")).toBe(false);
    expect(supportsNativeWindowsRoundedCorners("darwin", "24.5.0")).toBe(false);
    expect(supportsNativeWindowsRoundedCorners("linux", "6.8.0")).toBe(false);
  });
});

describe("resolveDesktopWindowChromeState", () => {
  it.each([
    ["24.6.0", 15],
    ["25.0.0", 26],
    ["invalid", null],
  ] as const)("maps Darwin release %s to macOS major %s", (release, macOSMajorVersion) => {
    expect(resolveDesktopWindowChromeState(false, "darwin", release)).toEqual({
      isMaximized: false,
      macOSMajorVersion,
      supportsNativeRoundedCorners: false,
    });
  });
});
