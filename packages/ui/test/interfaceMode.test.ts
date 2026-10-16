// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IBroadcastService } from "@zcode/services";
import { INTERFACE_MODE_STORAGE_KEY, normalizeInterfaceMode } from "@/lib/interfaceMode.js";
import { createZCodeStore } from "@/store/index.js";

describe("界面模式偏好", () => {
  beforeEach(() => localStorage.clear());

  it.each([
    [null, "coding"],
    [undefined, "coding"],
    ["invalid", "coding"],
    ["office", "office"],
    ["coding", "coding"],
    // CR-02：改名 office 前的旧名，存量 localStorage 值必须映射到 office 而不是重置成 coding。
    ["general", "office"],
    ["concise", "office"],
    ["professional", "coding"],
  ])("归一化 %s 为 %s", (value, expected) => {
    expect(normalizeInterfaceMode(value)).toBe(expected);
  });

  it("保存模式、跨窗口同步且不回播，不改写代码换行偏好", () => {
    let receive: Parameters<IBroadcastService["onMessage"]>[0] | undefined;
    const send = vi.fn(async () => {});
    const service: IBroadcastService = {
      send,
      acquireClaim: async () => ({ status: "unavailable" }),
      commitClaim: async () => {},
      releaseClaim: async () => {},
      tryClaim: async () => false,
      onMessage: (listener) => {
        receive = listener;
        return { dispose: () => {} };
      },
    };
    localStorage.setItem(INTERFACE_MODE_STORAGE_KEY, "office");
    const store = createZCodeStore(service);
    expect(store.getState().interfaceMode).toBe("office");
    store.getState().setCodePreviewSettings({ wrapLongLines: false });
    store.getState().setInterfaceMode("coding");
    expect(localStorage.getItem(INTERFACE_MODE_STORAGE_KEY)).toBe("coding");
    expect(send).toHaveBeenCalledWith({ channel: "state:interfaceMode", payload: "coding" });
    send.mockClear();
    receive?.({ channel: "state:interfaceMode", payload: "office" });
    expect(store.getState().interfaceMode).toBe("office");
    expect(localStorage.getItem(INTERFACE_MODE_STORAGE_KEY)).toBe("office");
    expect(store.getState().codePreviewSettings.wrapLongLines).toBe(false);
    expect(send).not.toHaveBeenCalled();
    receive?.({ channel: "state:interfaceMode", payload: "unexpected" });
    expect(store.getState().interfaceMode).toBe("office");
  });
});
