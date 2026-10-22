import { expect, it, vi } from "vitest";
import { normalizeRemoteConnectionOptions } from "@/remote-connection-flow/contract.js";
import { projectConnectionOptions } from "@/remote-connection-flow/contract.example.js";
it("项目接管保持回调与显式入口身份，默认不打开向导", async () => {
  const select = vi.fn(async () => {});
  const ready = vi.fn(async () => {});
  const options = normalizeRemoteConnectionOptions({
    ...projectConnectionOptions(
      {
        onConnect: async () => "connection",
        onCancelSession: async () => {},
        onSelectProject: select,
      },
      ready,
    ),
    openIntentId: 3,
  });
  expect(options.controlledOpen).toBeUndefined();
  expect(options.remoteWorkspaceSessions).toEqual([]);
  expect(options.openIntentId).toBe(3);
  await options.onConnectionReady?.("connection");
  expect(ready).toHaveBeenCalledWith("connection");
  expect(select).not.toHaveBeenCalled();
});
