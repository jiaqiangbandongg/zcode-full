// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IBroadcastService } from "@zcode/services";
import { createZCodeStore } from "@/store/index.js";

function createBroadcastFixture() {
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
  return { send, service, receive: () => receive };
}

describe("任务通知开关跨窗口同步", () => {
  beforeEach(() => localStorage.clear());

  it("切换开关广播 state:notificationEnabled，其他窗口按广播应用且不回播", () => {
    const { send, service, receive } = createBroadcastFixture();
    const store = createZCodeStore(service);
    expect(store.getState().notificationEnabled).toBe(true);

    // 窗口 A 关闭通知：本地生效并广播
    store.getState().setNotificationEnabled(false);
    expect(store.getState().notificationEnabled).toBe(false);
    expect(send).toHaveBeenCalledWith({ channel: "state:notificationEnabled", payload: false });
    send.mockClear();

    // 模拟窗口 B 收到广播：应用开关（含 localStorage 持久化），不回播
    receive()?.({ channel: "state:notificationEnabled", payload: false });
    expect(store.getState().notificationEnabled).toBe(false);
    expect(localStorage.getItem("zcode-notification-enabled")).toBe("false");
    expect(send).not.toHaveBeenCalled();

    // 非法 payload 不改变状态
    receive()?.({ channel: "state:notificationEnabled", payload: "unexpected" });
    expect(store.getState().notificationEnabled).toBe(false);
  });

  it("新窗口启动从 localStorage 读最新开关值（跨窗口共享持久层）", () => {
    localStorage.setItem("zcode-notification-enabled", "false");
    const { service } = createBroadcastFixture();
    const store = createZCodeStore(service);
    expect(store.getState().notificationEnabled).toBe(false);
  });
});
