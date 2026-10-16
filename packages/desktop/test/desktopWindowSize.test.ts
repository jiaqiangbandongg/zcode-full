import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachDesktopWindowSizePersistence,
  resolveDesktopWindowSize,
} from "../src/main/desktopWindowSize.js";

describe("desktopWindowSize", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to the default size when persisted state is absent", () => {
    expect(resolveDesktopWindowSize(undefined, { width: 1920, height: 1040 })).toEqual({
      width: 1200,
      height: 800,
      maximized: false,
    });
  });

  it("restores a valid normal size", () => {
    expect(
      resolveDesktopWindowSize(
        { width: 1440, height: 900, maximized: true },
        { width: 1920, height: 1040 },
      ),
    ).toEqual({ width: 1440, height: 900, maximized: true });
  });

  it("clamps a persisted size to the current display work area", () => {
    expect(
      resolveDesktopWindowSize(
        { width: 2560, height: 1440, maximized: false },
        { width: 1366, height: 728 },
      ),
    ).toEqual({ width: 1366, height: 728, maximized: false });
  });

  it("persists normal bounds separately from maximized state", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const save = vi.fn(async () => undefined);
    const win = {
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      getNormalBounds: vi.fn(() => ({ x: 20, y: 30, width: 1380, height: 860 })),
      on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    };

    attachDesktopWindowSizePersistence(win, save);
    listeners.get("resize")?.();
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(249);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(save).toHaveBeenLastCalledWith({ width: 1380, height: 860, maximized: false });

    win.isMaximized.mockReturnValue(true);
    listeners.get("maximize")?.();
    await Promise.resolve();
    expect(save).toHaveBeenLastCalledWith({ width: 1380, height: 860, maximized: true });

    win.isMaximized.mockReturnValue(false);
    listeners.get("unmaximize")?.();
    await Promise.resolve();
    expect(save).toHaveBeenLastCalledWith({ width: 1380, height: 860, maximized: false });
  });

  it("cancels a pending resize write when the window closes", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const save = vi.fn(async () => undefined);
    const win = {
      isDestroyed: vi.fn(() => false),
      isMaximized: vi.fn(() => false),
      getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1320, height: 840 })),
      on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    };

    attachDesktopWindowSizePersistence(win, save);
    listeners.get("resize")?.();
    listeners.get("close")?.();
    await vi.advanceTimersByTimeAsync(251);

    expect(listeners.has("close")).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
});
