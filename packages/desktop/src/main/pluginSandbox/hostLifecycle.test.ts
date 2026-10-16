import { describe, expect, it } from "vitest";
import { createPluginSandboxPermissionGate } from "./permissionGate.js";
import { createPluginSandboxProtocolHandler } from "./protocol.js";
import { createPluginSandboxRegistry } from "./registry.js";
const input = {
  instance: { runtimeId: "agent", generation: 1, token: "one", appIdentity: "a".repeat(64) },
  workspacePath: "/a",
  sessionId: "s",
  pluginId: "p",
  serverName: "m",
  scopeId: "surface:view",
  ownerWebContentsId: 1,
  html: "<html><head></head><body>one</body></html>",
  permissions: ["camera"] as const,
};
describe("MCP App native lifecycle", () => {
  it("prevents shared browser response caches from bypassing instance authorization", async () => {
    const registry = createPluginSandboxRegistry();
    const handle = registry.register({ ...input, permissions: [] });
    const read = createPluginSandboxProtocolHandler({
      registry,
      assets: { rendererDir: "/fixture", aliasDir: "/fixture" },
      readAsset: async () => new TextEncoder().encode("fixture"),
    });
    const plugin = `zcode-sandbox://plugin-${input.instance.appIdentity}/instance/${handle.sandboxId}/`;
    for (const url of [
      handle.shellUrl,
      `${handle.shellUrl}assets/shell.js`,
      `${plugin}index.html`,
      `${plugin}__zcode__/alias.js`,
    ]) {
      const response = await read(new Request(url));
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });
  it("keeps concurrent registration immutable and refuses to evict a fresh preparation", () => {
    const registry = createPluginSandboxRegistry({ maxEntries: 1 });
    const a = registry.register({ ...input, permissions: [] });
    expect(registry.register({ ...input, html: "late content", permissions: [] })).toEqual(a);
    expect(registry.get(a.sandboxId)?.html).toBe(input.html);
    expect(() =>
      registry.register({
        ...input,
        instance: { ...input.instance, token: "other" },
        permissions: [],
      }),
    ).toThrow();
    expect(registry.get(a.sandboxId)).not.toBeNull();
  });
  it("keeps storage stable across new runs and prevents old dispose from touching the replacement", () => {
    const registry = createPluginSandboxRegistry();
    const a = registry.register({ ...input, permissions: [...input.permissions] });
    const b = registry.register({
      ...input,
      instance: { ...input.instance, token: "two", generation: 2 },
      permissions: [...input.permissions],
    });
    expect(a.sandboxId).not.toBe(b.sandboxId);
    expect(a.partition).toBe(b.partition);
    registry.dispose(a.sandboxId, a.initId);
    expect(registry.get(b.sandboxId)).not.toBeNull();
    const c = registry.register({
      ...input,
      instance: { ...input.instance, token: "other", appIdentity: "b".repeat(64) },
      permissions: [],
    });
    expect(c.partition).not.toBe(b.partition);
  });
  it("rejects native confirmation that returns after its instance was replaced", async () => {
    const registry = createPluginSandboxRegistry();
    const a = registry.register({ ...input, permissions: [...input.permissions] });
    let answer!: (yes: boolean) => void;
    const gate = createPluginSandboxPermissionGate({
      registry,
      prompt: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    const pending = gate.request({
      permission: "media",
      mediaTypes: ["video"],
      requestingUrl: `zcode-sandbox://plugin-${input.instance.appIdentity}/instance/${a.sandboxId}/index.html`,
      guestUrl: a.shellUrl,
      isCurrent: () => true,
    });
    registry.dispose(a.sandboxId);
    answer(true);
    await expect(pending).resolves.toBe(false);
  });
  it("requires both stable identity and live resource token", async () => {
    const registry = createPluginSandboxRegistry();
    const a = registry.register({ ...input, permissions: [] });
    const read = createPluginSandboxProtocolHandler({
      registry,
      assets: { rendererDir: "/unused", aliasDir: "/unused" },
    });
    const good = `zcode-sandbox://plugin-${input.instance.appIdentity}/instance/${a.sandboxId}/index.html`;
    expect((await read(new Request(good))).status).toBe(200);
    expect(
      (await read(new Request(good.replace(input.instance.appIdentity, "b".repeat(64))))).status,
    ).toBe(404);
    registry.dispose(a.sandboxId);
    expect((await read(new Request(good))).status).toBe(404);
  });
  it("does not retain consent when system authorization finishes after revocation", async () => {
    const registry = createPluginSandboxRegistry();
    const a = registry.register({ ...input, permissions: [...input.permissions] });
    const entered = Promise.withResolvers<void>(),
      system = Promise.withResolvers<boolean>();
    const gate = createPluginSandboxPermissionGate({
      registry,
      prompt: async () => true,
      requestSystemMediaAccess: () => {
        entered.resolve();
        return system.promise;
      },
    });
    const origin = `zcode-sandbox://plugin-${input.instance.appIdentity}`;
    const pending = gate.request({
      permission: "media",
      mediaTypes: ["video"],
      guestUrl: a.shellUrl,
      requestingUrl: `${origin}/instance/${a.sandboxId}/index.html`,
      isCurrent: () => true,
    });
    await entered.promise;
    registry.dispose(a.sandboxId);
    system.resolve(true);
    await expect(pending).resolves.toBe(false);
    const b = registry.register({
      ...input,
      instance: { ...input.instance, token: "two" },
      permissions: [...input.permissions],
    });
    expect(
      gate.check({
        permission: "media",
        mediaType: "video",
        guestUrl: b.shellUrl,
        requestingOrigin: origin,
      }),
    ).toBe(false);
  });
});
