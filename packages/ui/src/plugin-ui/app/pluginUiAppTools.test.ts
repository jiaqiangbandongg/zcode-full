import { describe, expect, it, vi } from "vitest";
import { createPluginUiAppTools } from "./pluginUiAppTools.js";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";
const instance = { runtimeId: "agent", generation: 1, token: "one", appIdentity: "a".repeat(64) };
const scope = {
  instance,
  workspacePath: "/w",
  sessionId: "s",
  pluginId: "p",
  serverName: "server",
};
describe("official SDK app tool cancellation", () => {
  it("passes AbortSignal to SDK, executes once, and retains the original resolve binding", async () => {
    const executing = Promise.withResolvers<AbortSignal>();
    const finished = Promise.withResolvers<void>();
    const resolve = vi.fn(async (_input: unknown) => {
      finished.resolve();
      return { accepted: false };
    });
    const callTool = vi.fn(
      (_args, options) =>
        new Promise((_yes, no) => {
          executing.resolve(options.signal);
          options.signal.addEventListener("abort", () => no(new Error("cancelled")), {
            once: true,
          });
        }),
    );
    const owner = createPluginUiAppTools({
      bridge: {
        claimAppToolCall: async () => ({ accepted: true }),
        resolveAppToolCall: resolve,
        registerAppTools: async () => ({ tools: [] }),
        unregisterAppTools: async () => ({ removed: 0 }),
      },
      pluginScope: () => scope,
      scopeId: instance.token,
      currentGeneration: () => 1,
      setTimer: () => () => {},
    });
    const sdk = { callTool } as unknown as PluginUiHostBridge;
    const call = { callId: "call", toolName: "increment", arguments: {} };
    owner.execute(sdk, call);
    owner.execute(sdk, call);
    const signal = await executing.promise;
    owner.execute(sdk, { ...call, cancelled: true });
    expect(signal.aborted).toBe(true);
    await finished.promise;
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toMatchObject({
      ...scope,
      callId: "call",
      scopeId: instance.token,
      generation: 1,
    });
  });
  it("does not execute when cancellation precedes a delayed claim", async () => {
    const claim = Promise.withResolvers<{ accepted: boolean }>();
    const settled = Promise.withResolvers<void>();
    const callTool = vi.fn();
    let owner: ReturnType<typeof createPluginUiAppTools>;
    owner = createPluginUiAppTools({
      bridge: {
        claimAppToolCall: () => claim.promise,
        resolveAppToolCall: async () => ({ accepted: false }),
        registerAppTools: async () => ({ tools: [] }),
        unregisterAppTools: async () => ({ removed: 0 }),
      },
      pluginScope: () => scope,
      scopeId: instance.token,
      currentGeneration: () => 1,
      setTimer: () => () => {},
      onBusyChange: () => {
        if (!owner.isBusy()) settled.resolve();
      },
    });
    const sdk = { callTool } as unknown as PluginUiHostBridge;
    const call = { callId: "call", toolName: "increment", arguments: {} };
    owner.execute(sdk, call);
    owner.execute(sdk, { ...call, cancelled: true });
    claim.resolve({ accepted: true });
    await settled.promise;
    expect(callTool).not.toHaveBeenCalled();
  });
});
