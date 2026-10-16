import { describe, expect, it } from "vitest";
import {
  formatShiftCommandShortcutLabel,
  matchesCtrlShiftShortcut,
  matchesCtrlShortcut,
  matchesPrimaryAltShortcut,
  matchesPrimaryShiftShortcut,
  matchesPrimaryShortcut,
  matchesShiftTab,
} from "@/lib/keyboardShortcuts.js";

describe("keyboardShortcuts", () => {
  it("uses code as a fallback so macOS option-modified keys still match", () => {
    expect(
      matchesPrimaryAltShortcut(
        {
          key: "ß",
          code: "KeyB",
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: true,
        },
        "b",
        { platform: "MacIntel" },
      ),
    ).toBe(true);
  });

  it("still matches plain primary shortcuts by key or code", () => {
    expect(
      matchesPrimaryShortcut(
        {
          key: "b",
          code: "KeyB",
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
        },
        "b",
        { platform: "MacIntel" },
      ),
    ).toBe(true);
  });

  it("still matches ctrl shortcuts by key or code", () => {
    expect(
      matchesCtrlShortcut(
        {
          key: "m",
          code: "KeyM",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
        },
        "m",
      ),
    ).toBe(true);
  });

  it("matches ctrl shift shortcuts by key or code", () => {
    expect(
      matchesCtrlShiftShortcut(
        {
          key: "M",
          code: "KeyM",
          metaKey: false,
          ctrlKey: true,
          shiftKey: true,
          altKey: false,
        },
        "m",
      ),
    ).toBe(true);
    expect(
      matchesCtrlShiftShortcut(
        {
          key: "M",
          code: "KeyM",
          metaKey: true,
          ctrlKey: true,
          shiftKey: true,
          altKey: false,
        },
        "m",
      ),
    ).toBe(false);
  });

  it("matches primary shift shortcuts by key", () => {
    expect(
      matchesPrimaryShiftShortcut(
        {
          key: "P",
          code: "KeyP",
          metaKey: true,
          ctrlKey: false,
          shiftKey: true,
          altKey: false,
        },
        "p",
        { platform: "MacIntel" },
      ),
    ).toBe(true);
  });

  it("matches plain Shift+Tab without modifier keys", () => {
    expect(
      matchesShiftTab({
        key: "Tab",
        code: "Tab",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      matchesShiftTab({
        key: "Tab",
        code: "Tab",
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(false);
    expect(
      matchesShiftTab({
        key: "Tab",
        code: "Tab",
        metaKey: false,
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(false);
  });

  it("matches primary shortcuts with the platform primary modifier only", () => {
    const mac = { platform: "MacIntel" };
    const win = { platform: "Win32" };

    expect(
      matchesPrimaryShortcut(
        {
          key: "f",
          code: "KeyF",
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
        },
        "f",
        mac,
      ),
    ).toBe(true);
    expect(
      matchesPrimaryShortcut(
        {
          key: "f",
          code: "KeyF",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
        },
        "f",
        mac,
      ),
    ).toBe(false);
    expect(
      matchesPrimaryShortcut(
        {
          key: "f",
          code: "KeyF",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
        },
        "f",
        win,
      ),
    ).toBe(true);
    expect(
      matchesPrimaryShortcut(
        {
          key: "f",
          code: "KeyF",
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
        },
        "f",
        win,
      ),
    ).toBe(false);
    expect(
      matchesPrimaryShortcut(
        {
          key: "f",
          code: "KeyF",
          metaKey: true,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
        },
        "f",
        mac,
      ),
    ).toBe(false);
  });

  it("uses the platform primary modifier for shift and alt shortcut variants", () => {
    const mac = { platform: "MacIntel" };
    const linux = { platform: "Linux x86_64" };

    expect(
      matchesPrimaryShiftShortcut(
        {
          key: "P",
          code: "KeyP",
          metaKey: true,
          ctrlKey: false,
          shiftKey: true,
          altKey: false,
        },
        "p",
        mac,
      ),
    ).toBe(true);
    expect(
      matchesPrimaryShiftShortcut(
        {
          key: "P",
          code: "KeyP",
          metaKey: false,
          ctrlKey: true,
          shiftKey: true,
          altKey: false,
        },
        "p",
        mac,
      ),
    ).toBe(false);
    expect(
      matchesPrimaryAltShortcut(
        {
          key: "ß",
          code: "KeyB",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: true,
        },
        "b",
        linux,
      ),
    ).toBe(true);
    expect(
      matchesPrimaryAltShortcut(
        {
          key: "ß",
          code: "KeyB",
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: true,
        },
        "b",
        linux,
      ),
    ).toBe(false);
  });

  it("formats primary shift shortcuts for each platform", () => {
    expect(
      formatShiftCommandShortcutLabel("p", {
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
      }),
    ).toBe("⇧ ⌘ P");
    expect(
      formatShiftCommandShortcutLabel("p", {
        platform: "Linux x86_64",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      }),
    ).toBe("Ctrl+Shift+P");
    expect(
      formatShiftCommandShortcutLabel("[", {
        platform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
      }),
    ).toBe("⇧ ⌘ [");
  });
});
