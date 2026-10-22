import { ChannelServer, ProxyChannel } from "@zcode/rpc";
import { createAcknowledgedWebRemoteControlRelayProtocol } from "@zcode/client";
import {
  connectWebRemoteControlWorkspaceBridgeServices,
  replayWebRemoteControlWorkspaceBridgeFrames,
} from "@web/web-remote-control/index.js";
import { expect, it, vi } from "vitest";

function fixture(
  getCapabilities: () => Promise<{ version: number }> = async () => ({ version: 1 }),
  dropFirstRequest = false,
) {
  let replacement: ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol> | undefined;
  let active: ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol> | undefined;
  let reportDroppedRequest!: () => void;
  const requestDropped = new Promise<void>((resolve) => {
    reportDroppedRequest = resolve;
  });
  const identity = { bridgeSessionId: "bridge-new", bridgeGeneration: 2 };
  const desktop = createAcknowledgedWebRemoteControlRelayProtocol({
    ...identity,
    sendFrame: (frame) => {
      queueMicrotask(() => active?.acceptPayload(frame));
      return true;
    },
  });
  const mobile = createAcknowledgedWebRemoteControlRelayProtocol({
    ...identity,
    sendFrame: (frame) => {
      if (dropFirstRequest && frame.zcode_type === "rpc-frame") {
        dropFirstRequest = false;
        reportDroppedRequest();
        return true;
      }
      queueMicrotask(() => desktop.acceptPayload(frame));
      return true;
    },
  });
  const server = new ChannelServer(desktop.protocol, "host", 20);
  server.registerChannel("window-project-changes", ProxyChannel.fromService({ getCapabilities }));
  const activateTransport = vi.fn(() => {
    active = mobile;
    return () => {
      if (active === mobile) active = undefined;
    };
  });
  return {
    mobile,
    desktop,
    requestDropped,
    activateTransport,
    replace: () => {
      replacement = createAcknowledgedWebRemoteControlRelayProtocol({
        bridgeSessionId: "newer",
        sendFrame: () => true,
      });
      active = replacement;
      return replacement;
    },
    active: () => active,
    dispose: () => {
      mobile.dispose();
      desktop.dispose();
      replacement?.dispose();
      server.dispose();
    },
  };
}

it("MRO02：真实 relay 的能力回包在服务公开前到达，不因仅派发旧 bridge 而死锁", async () => {
  const f = fixture();
  try {
    const services = await connectWebRemoteControlWorkspaceBridgeServices({
      relayProtocol: f.mobile,
      windowProjectDirectory: true,
      activateTransport: f.activateTransport,
      isCurrent: () => true,
    });
    expect(f.activateTransport).toHaveBeenCalledOnce();
    expect(services.windowProjectDirectory).toBeDefined();
  } finally {
    f.dispose();
  }
});

it.each(["absent", "healthy", "degraded"] as const)(
  "MRO02：能力请求丢帧后 send-ready 重放待就绪 bridge，旧 bridge 为 %s",
  async (previousState) => {
    const getCapabilities = vi.fn(async () => ({ version: 1 }));
    const f = fixture(getCapabilities, true);
    const previous =
      previousState === "absent"
        ? undefined
        : createAcknowledgedWebRemoteControlRelayProtocol({
            bridgeSessionId: "bridge-old",
            bridgeGeneration: 1,
            sendFrame: () => true,
          });
    if (previousState === "degraded") previous!.markDegraded();
    const replayPrevious = previous && vi.spyOn(previous, "replayUnacknowledged");
    const abort = new AbortController();
    const ready = connectWebRemoteControlWorkspaceBridgeServices({
      relayProtocol: f.mobile,
      windowProjectDirectory: true,
      activateTransport: f.activateTransport,
      isCurrent: () => true,
      signal: abort.signal,
    });
    // 失败断言后的清理会取消就绪等待；显式消费拒绝，保留原始断言作为失败原因。
    void ready.catch(() => {});
    try {
      await f.requestDropped;
      expect(f.desktop.unacknowledgedBytes).toBe(0);
      expect(f.mobile.unacknowledgedBytes).toBeGreaterThan(0);
      expect(getCapabilities).not.toHaveBeenCalled();

      replayWebRemoteControlWorkspaceBridgeFrames({
        activeRelayProtocol: previous,
        pendingRelayProtocol: f.mobile,
      });
      f.desktop.replayUnacknowledged();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(getCapabilities).toHaveBeenCalledOnce();
      expect((await ready).windowProjectDirectory).toBeDefined();
      if (previousState === "healthy") expect(replayPrevious).toHaveBeenCalledOnce();
      if (previousState === "degraded") expect(replayPrevious).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      previous?.dispose();
      f.dispose();
    }
  },
);

it.each(["cancelled", "replaced"])("MRO02：能力回包迟到后拒绝发布服务：%s", async (reason) => {
  let release!: () => void;
  let started!: () => void;
  const received = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = fixture(async () => {
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { version: 1 };
  });
  let current = true;
  const abort = new AbortController();
  try {
    const ready = connectWebRemoteControlWorkspaceBridgeServices({
      relayProtocol: f.mobile,
      windowProjectDirectory: true,
      activateTransport: f.activateTransport,
      isCurrent: () => current,
      signal: abort.signal,
    });
    const rejected = expect(ready).rejects.toThrow("superseded");
    await received;
    current = false;
    const replacement = reason === "replaced" ? f.replace() : undefined;
    abort.abort();
    await rejected;
    release();
    expect(f.active()).toBe(replacement);
  } finally {
    f.dispose();
  }
});

it("MRO02：声明能力但协议版本不支持时清理传输并明确拒绝", async () => {
  const f = fixture(async () => ({ version: 2 }));
  try {
    await expect(
      connectWebRemoteControlWorkspaceBridgeServices({
        relayProtocol: f.mobile,
        windowProjectDirectory: true,
        activateTransport: f.activateTransport,
        isCurrent: () => true,
      }),
    ).rejects.toThrow("window-project-directory.unsupported");
    expect(f.active()).toBeUndefined();
  } finally {
    f.dispose();
  }
});
