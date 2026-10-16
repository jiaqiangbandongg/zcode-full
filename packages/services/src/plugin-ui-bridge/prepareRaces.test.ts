import { describe, expect, it, vi } from "vitest";
import type { PluginSandboxRegisterInput } from "@zcode/shared/mcp-apps";
import { createPluginUiBridgeService } from "./pluginUiBridgeService.js";
const instance = { runtimeId: "agent", generation: 1, token: "token", appIdentity: "a".repeat(64) };
const params = {
  workspacePath: "/a",
  sessionId: "s",
  pluginId: "p",
  serverName: "m",
  scopeId: "surface:x",
  resourceUri: "ui://x",
  ownerWebContentsId: 1,
};
describe("MCP App preparation", () => {
  it("coalesces identical initialization but isolates server, workspace and resource", async () => {
    const open = vi.fn(async (p: typeof params & { workspaceIdentity?: string }) => ({
      ...instance,
      token: JSON.stringify([p.serverName, p.resourceUri, p.workspaceIdentity ?? p.workspacePath]),
    }));
    const read = vi.fn(async (input: { uri: string; instance: typeof instance }) => ({
      contents: [{ uri: input.uri, mimeType: "text/html", text: "<p>fixture</p>" }],
    }));
    const register = vi.fn(async (input: PluginSandboxRegisterInput) => ({
      instance: input.instance,
      sandboxId: input.instance.token,
      initId: 1,
      shellUrl: "url",
      partition: "partition",
    }));
    const bridge = createPluginUiBridgeService({
      openInstance: open,
      readMcpResource: read,
      registerSandbox: register,
    });
    const a = bridge.prepareSandbox(params),
      b = bridge.prepareSandbox({ ...params });
    const first = await Promise.all([a, b]);
    expect(first[0]).toEqual(first[1]);
    expect(open).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
    const others = await Promise.all([
      bridge.prepareSandbox({ ...params, serverName: "other" }),
      bridge.prepareSandbox({ ...params, resourceUri: "ui://other" }),
      bridge.prepareSandbox({ ...params, workspaceIdentity: "other" }),
    ]);
    expect(open).toHaveBeenCalledTimes(5);
    expect(read).toHaveBeenCalledTimes(4);
    expect(register).toHaveBeenCalledTimes(4);
    expect(new Set([first[0], ...others].map((handle) => handle.sandboxId)).size).toBe(4);
    expect(register.mock.calls.map(([input]) => input.instance.token)).toEqual(
      read.mock.calls.map(([input]) => input.instance.token),
    );
  });
  it("revokes the credential when resource validation fails", async () => {
    const close = vi.fn(async () => {});
    const bridge = createPluginUiBridgeService({
      openInstance: async () => instance,
      closeInstance: close,
      readMcpResource: async () => ({ contents: [] }),
      registerSandbox: vi.fn(),
    });
    await expect(bridge.prepareSandbox(params)).rejects.toThrow("no contents");
    expect(close).toHaveBeenCalledWith({ ...params, instance });
  });
});
