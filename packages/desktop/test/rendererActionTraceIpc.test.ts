import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels, type RendererActionTraceConfigV1 } from "@zcode/shared";

const ipcListeners = new Map<string, (event: unknown, payload: unknown) => void>();

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
      ipcListeners.set(channel, listener);
    }),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
  },
}));

import { registerRendererActionTraceIpc } from "../src/main/rendererActionTraceIpc.js";

const config: RendererActionTraceConfigV1 = {
  enabled: true,
  sampleRatio: 1,
  enabledGroups: ["core", "settings"],
  configVersion: "test",
};

class FakeWebContents extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
}

function createBatch(rendererInstanceId: string) {
  return {
    version: 1,
    rendererInstanceId,
    sequence: 1,
    droppedSinceLastFlush: 0,
    resource: {
      serviceName: "zcode-desktop-renderer",
      serviceVersion: "test",
      deploymentEnvironment: "test",
      rendererInstanceId,
    },
    spans: [],
  };
}

describe("renderer action trace IPC", () => {
  beforeEach(() => {
    ipcListeners.clear();
  });

  it("rebinds a sender after renderer lifecycle reset while rejecting stale instances", () => {
    const sender = new FakeWebContents(7);
    const enqueue = vi.fn(() => true);
    const warn = vi.fn();
    const dispose = registerRendererActionTraceIpc({
      rollout: {
        getSnapshot: () => config,
        refresh: async () => config,
      },
      broker: { enqueue, flush: vi.fn(), shutdown: vi.fn() },
      logger: { debug: vi.fn(), warn },
    });
    const listener = ipcListeners.get(PlatformChannels.ReportRendererActionTraceBatch);
    if (!listener) throw new Error("IPC listener was not registered");

    listener({ sender }, createBatch("renderer-a"));
    sender.emit("did-start-loading");
    listener({ sender }, createBatch("renderer-a"));
    listener({ sender }, createBatch("renderer-b"));
    sender.emit("did-navigate");
    listener({ sender }, createBatch("renderer-b"));

    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ rendererInstanceId: "renderer-a" });
    expect(enqueue.mock.calls[1]?.[0]).toMatchObject({ rendererInstanceId: "renderer-b" });
    expect(enqueue.mock.calls[2]?.[0]).toMatchObject({ rendererInstanceId: "renderer-b" });
    expect(warn).toHaveBeenCalledWith(
      "[renderer-action-trace] stale renderer instance for sender",
      expect.objectContaining({ senderId: 7 }),
    );

    dispose();
  });
});
