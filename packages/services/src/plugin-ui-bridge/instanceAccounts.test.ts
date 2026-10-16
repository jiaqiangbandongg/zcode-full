import { describe, expect, it, vi } from "vitest";
import { createPluginUiAccountBindings } from "./instanceAccounts.js";
const instance = { runtimeId: "agent", generation: 1, token: "one", appIdentity: "a".repeat(64) };
const params = {
  workspacePath: "/w",
  sessionId: "s",
  pluginId: "p",
  serverName: "server",
  scopeId: "view",
  resourceUri: "ui://app",
  ownerWebContentsId: 1,
};
describe("Host account identity", () => {
  it("uses stable account facts and revokes only captured old credentials", async () => {
    let account = "alice";
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => instance);
    const owner = createPluginUiAccountBindings({
      readAccount: async () => ["provider", account],
      open,
      close,
    });
    await owner.open(params);
    await owner.open(params);
    expect(open.mock.calls[0]).toEqual(open.mock.calls[1]);
    owner.invalidate();
    account = "bob";
    await owner.open(params);
    expect(open.mock.calls[2]).not.toEqual(open.mock.calls[0]);
    expect(close).toHaveBeenCalledExactlyOnceWith({ ...params, instance });
  });
  it("closes an open result arriving after account revocation", async () => {
    const gate = Promise.withResolvers<typeof instance>();
    const entered = Promise.withResolvers<void>();
    const close = vi.fn(async () => {});
    const owner = createPluginUiAccountBindings({
      readAccount: async () => "alice",
      open: () => {
        entered.resolve();
        return gate.promise;
      },
      close,
    });
    const pending = owner.open(params);
    const rejected = expect(pending).rejects.toThrow("account changed");
    await entered.promise;
    owner.invalidate();
    gate.resolve(instance);
    await rejected;
    expect(close).toHaveBeenCalledExactlyOnceWith({ ...params, instance });
  });
});
