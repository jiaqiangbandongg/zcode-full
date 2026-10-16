import { expect, it, vi } from "vitest";
import type { IChannelClient } from "@zcode/rpc";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";
it("connects the renderer sampling accessor to the host sampling RPC channel", async () => {
  const call = vi.fn(async (..._args: unknown[]) => ({ cancelled: false }));
  const getChannel = vi.fn((name: string) => ({
    call: (...args: unknown[]) => call(name, ...args),
    listen: vi.fn(),
  }));
  const access = new RemoteServiceAccess({ getChannel } as unknown as IChannelClient);
  const binding = {
    workspacePath: "/repo",
    sessionId: "task",
    pluginId: "math",
    serverName: "math",
    instance: {
      runtimeId: "agent",
      generation: 1,
      token: "credential",
      appIdentity: "a".repeat(64),
    },
    operationId: "one",
  };
  await access.pluginUiSamplingService.cancelSampling(binding);
  expect(call).toHaveBeenCalledWith("plugin-ui-sampling", "cancelSampling", [binding]);
});
