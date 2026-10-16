import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtocolRuntimeResources } from "../src/zcode-protocol/runtime-resources.js";
import { cleanupProtocolRuntime } from "../src/zcode-protocol/runtime-cleanup.js";
import { acquireProtocolStartupResource } from "../src/zcode-protocol/startup-resource.js";
import { createFakeApp } from "./helpers/fake-zcode-app.js";
import type { Logger } from "@zcode/contracts";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";

const telemetry = vi.hoisted(() => ({ shutdown: vi.fn(async () => {}) }));
vi.mock("@zcode/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zcode/telemetry")>()),
  shutdownPreparedModelTelemetry: telemetry.shutdown,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function fakeApp() {
  const close = vi.fn(async () => {});
  const app = createFakeApp(undefined, { close });
  app.runtime.beginShutdown = vi.fn();
  app.runtime.stopActiveForegroundExecution = vi.fn(() => ({ kind: "idle" }));
  return { app, close };
}

describe("protocol runtime resource ownership", () => {
  it.each(["desktop-continuous", "web-remote-replayable"])(
    "shutdown preserves the %s session without removal events",
    async (deliveryKind) => {
      const close = vi.fn(async () => {});
      const eventStore = createInMemorySessionEventStore();
      const deleteSession = vi.spyOn(eventStore, "deleteSession");
      const notifications: unknown[] = [];
      let sessionId = "";
      const server = new ZCodeProtocolAgentServer({
        createZCodeApp: (options) => {
          const app = createFakeApp(options, { close });
          sessionId = app.sessionId;
          app.runtime.beginShutdown = vi.fn();
          return app;
        },
        createSessionEventStore: () => eventStore,
        cwd: "/workspace/app",
      });
      server.setNotificationSink((message) => {
        if ("id" in message && message.method === "session/requestRuntimePreferences") {
          void server.handleMessage({
            id: message.id,
            result: { nativeSearchEnhancementsEnabled: false },
          });
        } else notifications.push(message);
      });
      const created = await server.handleMessage({
        id: "create",
        method: "session/create",
        params: {
          workspace: { workspacePath: "/workspace/app", workspaceKey: "/workspace/app" },
        },
      });
      expect(created, JSON.stringify(created)).toHaveProperty("result");
      const read = {
        id: "read",
        method: "session/read",
        params: { sessionId, deliveryKind },
      };
      const snapshot = await server.handleMessage(read);
      expect(snapshot, JSON.stringify(snapshot)).toHaveProperty("result");
      notifications.length = 0;
      await server.shutdown();
      server.disposeProjections();
      expect(close).toHaveBeenCalledOnce();
      expect(deleteSession).not.toHaveBeenCalled();
      expect(notifications).toEqual([]);
      await expect(server.handleMessage(read)).rejects.toThrow("stopping");
    },
  );

  it("interrupts a hung startup immediately and disposes its late result", async () => {
    const controller = new AbortController();
    const disposeLate = vi.fn();
    let finish!: (value: string) => void;
    const creating = acquireProtocolStartupResource({
      signal: controller.signal,
      logger: { warn: vi.fn() } as unknown as Logger,
      create: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
      disposeLate,
    });
    await Promise.resolve();
    controller.abort(new Error("parent gone"));
    await expect(creating).rejects.toThrow("parent gone");
    finish("late store");
    await vi.waitFor(() => expect(disposeLate).toHaveBeenCalledExactlyOnceWith("late store"));
  });

  it("stops foreground execution and closes each app once, including transient apps", async () => {
    const first = fakeApp();
    const second = fakeApp();
    const factory = vi.fn().mockResolvedValueOnce(first.app).mockResolvedValueOnce(second.app);
    const resources = new ProtocolRuntimeResources(factory);
    const app = await resources.create();
    await resources.create();
    await Promise.all([resources.close(), resources.close(), app.close?.()]);
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(first.app.runtime.beginShutdown).toHaveBeenCalledOnce();
    expect(second.app.runtime.stopActiveForegroundExecution).toHaveBeenCalledOnce();
    await expect(resources.create()).rejects.toThrow("stopping");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("closes a late app from an already accepted creation and rejects publication", async () => {
    const { app, close } = fakeApp();
    let resolve!: (value: typeof app) => void;
    const resources = new ProtocolRuntimeResources(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const creating = resources.create();
    const rejected = expect(creating).rejects.toThrow("stopping");
    await resources.close();
    resolve(app);
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    expect(app.runtime.stopActiveForegroundExecution).toHaveBeenCalledOnce();
  });

  it("does not retain an app that was already closed normally", async () => {
    const { app, close } = fakeApp();
    const resources = new ProtocolRuntimeResources(async () => app);
    await resources.create();
    await app.close?.();
    await resources.close();
    expect(close).toHaveBeenCalledOnce();
    expect(app.runtime.beginShutdown).not.toHaveBeenCalled();
  });

  it("shares one deadline and still attempts later owners when an earlier close hangs", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const cleanup = cleanupProtocolRuntime({
      logger: { warn: vi.fn() } as unknown as Logger,
      deadlineAt: Date.now() + 450,
      server: {
        shutdown: () => {
          order.push("apps");
          return new Promise(() => {});
        },
        disposeProjections: () => {
          order.push("projections");
        },
      },
      mcpPort: {
        close: async () => {
          order.push("mcp");
          throw new Error("closed");
        },
      },
      mcpConnectionPool: {
        close: () => {
          order.push("pool");
          return new Promise(() => {});
        },
      },
      providerRegistryRuntime: {
        dispose: () => {
          order.push("registry");
        },
      },
    });
    let completed = false;
    void cleanup.then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(451);
    expect(completed).toBe(true);
    expect(order).toEqual(["apps", "projections", "mcp", "pool", "registry"]);
    expect(telemetry.shutdown).toHaveBeenCalledOnce();
    await cleanup;
  });
});
