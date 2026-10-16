import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { describe, expect, it, vi } from "vitest";
import {
  createPluginUiHostController,
  type PluginUiHostControllerDeps,
} from "./pluginUiHostController.js";

const handle: PluginSandboxHandle = {
  sandboxId: "old",
  initId: 1,
  partition: "partition",
  shellUrl: "shell",
  instance: { runtimeId: "agent", generation: 1, token: "one", appIdentity: "a".repeat(64) },
};
function fixture() {
  const prepared = Promise.withResolvers<PluginSandboxHandle>();
  const entered = Promise.withResolvers<void>();
  const mounted = Promise.withResolvers<void>();
  const order: string[] = [];
  const close = vi.fn(async () => {
    order.push("revoke");
  });
  const dispose = vi.fn(async () => {
    order.push("guest");
  });
  const onPhase = vi.fn((phase: string) => {
    if (phase === "mounted") mounted.resolve();
  });
  const deps = {
    bridge: {
      prepareSandbox: () => {
        entered.resolve();
        return prepared.promise;
      },
      validateInstance: async () => {},
      closeInstance: close,
    },
    platform: {
      getOwnerWebContentsId: async () => 1,
      disposeSandbox: dispose,
      onPorts: () => () => {},
    },
    scope: { workspacePath: "/w", sessionId: "s", scope: { kind: "surface", surfaceId: "panel" } },
    presentation: { pluginId: "p", serverName: "m", resourceUri: "ui://app" },
    initialHostContext: {},
    hostVersion: "fixture",
    getToolFeed: () => ({}),
    getWidgetState: () => undefined,
    getHostCapabilities: () => ({}),
    onPhase,
    onDisplayModeRequest: (mode: string) => mode,
    onHeight: () => {},
    onOpenExternal: () => {},
    createTransport: vi.fn(),
  } as unknown as PluginUiHostControllerDeps;
  return {
    controller: createPluginUiHostController(deps),
    deps,
    prepared,
    entered,
    mounted,
    close,
    dispose,
    order,
    onPhase,
  };
}
describe("controller preparation and disposal", () => {
  it("delivers a source revocation received while recycling fails", async () => {
    const f = fixture();
    let revoked!: () => void;
    const response = Promise.withResolvers<boolean>();
    f.deps.bridge.recycleInstance = () => response.promise;
    f.deps.onInstanceClosed = vi.fn();
    f.deps.resourceNotifications = {
      register: (_generation, target) => {
        revoked = () => target.notifyInstanceClosed?.();
        return () => {};
      },
    };
    f.controller.start();
    await f.entered.promise;
    f.prepared.resolve(handle);
    await f.mounted.promise;
    const recycling = f.controller.tryRecycle();
    revoked();
    expect(f.deps.onInstanceClosed).not.toHaveBeenCalled();
    response.reject(new Error("connection lost"));
    await expect(recycling).rejects.toThrow("connection lost");
    expect(f.deps.onInstanceClosed).toHaveBeenCalledOnce();
    await f.controller.dispose();
  });
  it("waits for late preparation to release only its original credential and guest", async () => {
    const old = fixture();
    old.controller.start();
    await old.entered.promise;
    const disposal = old.controller.dispose();
    const newer = fixture();
    newer.controller.start();
    await newer.entered.promise;
    newer.prepared.resolve({
      ...handle,
      sandboxId: "new",
      instance: { ...handle.instance, token: "two", generation: 2 },
    });
    await newer.mounted.promise;
    old.prepared.resolve(handle);
    await disposal;
    expect(old.order).toEqual(["revoke", "guest"]);
    expect(old.dispose).toHaveBeenCalledExactlyOnceWith("old", 1);
    expect(newer.controller.phase).toBe("mounted");
    expect(newer.dispose).not.toHaveBeenCalled();
    await newer.controller.dispose();
  });
  it("revokes before releasing the guest and makes repeated disposal idempotent", async () => {
    const f = fixture();
    f.controller.start();
    await f.entered.promise;
    f.prepared.resolve(handle);
    await f.mounted.promise;
    const a = f.controller.dispose(),
      b = f.controller.dispose();
    expect(a).toBe(b);
    await a;
    expect(f.order).toEqual(["revoke", "guest"]);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
});
