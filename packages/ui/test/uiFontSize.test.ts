import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyUiFontSizePx,
  DEFAULT_UI_FONT_SIZE_PX,
  loadUiFontSizePx,
  normalizeUiFontSizePx,
  subscribeToUiFontSizeStorageChanges,
  UI_FONT_SIZE_STORAGE_KEY,
} from "../src/lib/uiFontSize.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uiFontSize", () => {
  it("缺少持久化值时使用 14px 默认存储值", () => {
    vi.stubGlobal("localStorage", { getItem: () => null });
    expect(loadUiFontSizePx()).toBe(DEFAULT_UI_FONT_SIZE_PX);
  });

  it("把 UI 字号限制在 12px 到 20px", () => {
    expect(normalizeUiFontSizePx(10)).toBe(12);
    expect(normalizeUiFontSizePx(16.6)).toBe(17);
    expect(normalizeUiFontSizePx(24)).toBe(20);
  });

  it("通过 UI 自定义属性应用字号，但不修改根 DOM 字号", () => {
    const properties = new Map<string, string>();
    const style = {
      fontSize: "",
      setProperty: (name: string, value: string) => properties.set(name, value),
    };
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === UI_FONT_SIZE_STORAGE_KEY ? "16" : null),
    });
    vi.stubGlobal("document", { documentElement: { style } });

    const fontSizePx = loadUiFontSizePx();
    applyUiFontSizePx(fontSizePx);

    expect(fontSizePx).toBe(16);
    expect(style.fontSize).toBe("");
    expect(properties.get("--ui-font-size")).toBe("16px");
  });

  it("监听其他窗口的字号存储变化并支持清理订阅", () => {
    const properties = new Map<string, string>();
    const listeners = new Map<string, EventListener>();
    const windowStub = {
      addEventListener: vi.fn((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListener) => {
        if (listeners.get(type) === listener) listeners.delete(type);
      }),
    };
    vi.stubGlobal("window", windowStub);
    vi.stubGlobal("document", {
      documentElement: {
        style: {
          setProperty: (name: string, value: string) => properties.set(name, value),
        },
      },
    });

    const dispose = subscribeToUiFontSizeStorageChanges();
    listeners.get("storage")?.({
      key: UI_FONT_SIZE_STORAGE_KEY,
      newValue: "20",
    } as StorageEvent);

    expect(properties.get("--ui-font-size")).toBe("20px");
    dispose();
    expect(windowStub.removeEventListener).toHaveBeenCalledOnce();
    expect(listeners.has("storage")).toBe(false);
  });
});
