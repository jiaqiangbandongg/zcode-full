import { describe, expect, it, vi } from "vitest";
import { createPluginUiSampling } from "./pluginUiSampling.js";
import type { PluginUiHostBridge } from "./pluginUiHostBridge.js";
const request = {
  messages: [{ role: "user" as const, content: { type: "text" as const, text: "1+1?" } }],
  maxTokens: 10,
};
const result = {
  role: "assistant" as const,
  content: { type: "text" as const, text: "2" },
  model: "fixture",
  stopReason: "endTurn",
};
const scope = {
  workspacePath: "/fixture",
  sessionId: "s",
  pluginId: "p",
  serverName: "mcp",
  instance: { runtimeId: "r", token: "t", generation: 1, appIdentity: "a".repeat(64) },
};
describe("sampling SDK bridge", () => {
  function setup() {
    const gate = Promise.withResolvers<typeof result>();
    const service = {
      sample: vi.fn(() => gate.promise),
      cancelSampling: vi.fn(async () => ({ cancelled: true })),
    };
    const activeCalls = new Set<string>();
    const canSample = vi.fn(() => true);
    const sampling = createPluginUiSampling({
      bridge: service,
      scope: () => scope,
      createCallId: () => "op",
      activeCalls,
      canSample,
    });
    const bridge = {} as PluginUiHostBridge;
    let current = true;
    sampling.install(bridge, () => current);
    return {
      gate,
      service,
      activeCalls,
      sampling,
      bridge,
      canSample,
      retire: () => {
        current = false;
      },
    };
  }
  it("binds identity, retains busy and returns the official result", async () => {
    const s = setup();
    const promise = s.bridge.oncreatesamplingmessage!(request, {});
    expect(s.activeCalls.size).toBe(1);
    expect(s.service.sample).toHaveBeenCalledWith({ ...scope, operationId: "op", request });
    s.gate.resolve(result);
    expect(await promise).toEqual(result);
    expect(s.activeCalls.size).toBe(0);
  });
  it("propagates SDK cancellation once and rejects late results", async () => {
    const s = setup(),
      abort = new AbortController();
    const promise = s.bridge.oncreatesamplingmessage!(request, {
      mcpReq: { signal: abort.signal },
    });
    const rejected = expect(promise).rejects.toThrow();
    abort.abort();
    s.sampling.reset();
    expect(s.service.cancelSampling).toHaveBeenCalledTimes(1);
    s.gate.resolve(result);
    await rejected;
    expect(s.activeCalls.size).toBe(0);
  });
  it("reset cancels old requests and old completion cannot reach a new bridge", async () => {
    const s = setup();
    const promise = s.bridge.oncreatesamplingmessage!(request, {});
    const rejected = expect(promise).rejects.toThrow();
    s.retire();
    s.sampling.reset();
    s.gate.resolve(result);
    await rejected;
    expect(s.service.cancelSampling).toHaveBeenCalledWith({ ...scope, operationId: "op" });
  });
  it("fails before execution for read-only, missing task or unsupported input", async () => {
    const s = setup();
    s.canSample.mockReturnValue(false);
    await expect(s.bridge.oncreatesamplingmessage!(request, {})).rejects.toThrow("unavailable");
    s.canSample.mockReturnValue(true);
    await expect(
      s.bridge.oncreatesamplingmessage!({ ...request, temperature: 0 }, {}),
    ).rejects.toThrow("Unsupported");
    expect(s.service.sample).not.toHaveBeenCalled();
  });
});
