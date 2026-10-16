import { describe, expect, it } from "vitest";
import { McpUiInstances, mcpUiInstances } from "./instances.js";
import { createMcpUiSessionAccess } from "./sessionAccess.js";
const binding = {
  workspace: "w",
  sessionId: "s",
  pluginId: "p",
  serverName: "m",
  scopeId: "v",
  resourceUri: "ui://app",
  ownerWebContentsId: 1,
};
describe("MCP App credentials", () => {
  it("rejects a resource read completing after its connection was replaced", async () => {
    let source = { identity: "source", generation: 1 };
    const lease = mcpUiInstances.open(binding, source);
    const result = Promise.withResolvers<{ contents: [] }>();
    const record = {
      app: { getMcpAppConnectionSnapshot: () => source, readMcpResource: () => result.promise },
    } as unknown as Parameters<typeof createMcpUiSessionAccess>[0];
    const scope = { ...binding, workspace: { workspacePath: binding.workspace }, instance: lease };
    const access = createMcpUiSessionAccess(record, scope);
    const reading = access.readResource(binding.serverName, binding.resourceUri);
    const rejected = expect(reading).rejects.toThrow("no longer authorized");
    source = { ...source, generation: 2 };
    const replacement = mcpUiInstances.open(binding, source);
    result.resolve({ contents: [] });
    await rejected;
    expect(mcpUiInstances.validate(replacement, scope, source).lease).toEqual(replacement);
    mcpUiInstances.close(replacement);
  });
  it("rejects old completion and late disposal without touching the replacement", () => {
    const owner = new McpUiInstances();
    const source = { identity: "source", generation: 1 };
    const a = owner.open(binding, source);
    owner.close(a);
    const b = owner.open(binding, source);
    expect(() =>
      owner.validate(a, { ...binding, workspace: { workspacePath: binding.workspace } }, source),
    ).toThrow();
    expect(owner.close(a)).toBe(false);
    expect(
      owner.validate(b, { ...binding, workspace: { workspacePath: binding.workspace } }, source)
        .lease,
    ).toEqual(b);
  });
  it("isolates workspace, server, owner and connection generation", () => {
    const owner = new McpUiInstances();
    const source = { identity: "source", generation: 1 };
    const a = owner.open(binding, source);
    const b = owner.open({ ...binding, workspace: "other" }, source);
    expect(a.appIdentity).not.toBe(b.appIdentity);
    expect(() =>
      owner.validate(
        a,
        { ...binding, workspace: { workspacePath: binding.workspace }, serverName: "other" },
        source,
      ),
    ).toThrow();
    expect(() =>
      owner.validate(
        a,
        { ...binding, workspace: { workspacePath: binding.workspace } },
        { ...source, generation: 2 },
      ),
    ).toThrow();
  });
  it("invalidates before abort listeners and disposes only once", () => {
    const owner = new McpUiInstances();
    const source = { identity: "source", generation: 1 };
    const a = owner.open(binding, source);
    const record = owner.validate(
      a,
      { ...binding, workspace: { workspacePath: binding.workspace } },
      source,
    );
    record.cancel.signal.addEventListener("abort", () =>
      expect(() =>
        owner.validate(a, { ...binding, workspace: { workspacePath: binding.workspace } }, source),
      ).toThrow(),
    );
    expect(owner.close(a)).toBe(true);
    expect(owner.close(a)).toBe(false);
    expect(record.cancel.signal.aborted).toBe(true);
  });
  it("shares storage identity across owners but closing one cannot revoke the other", () => {
    const owner = new McpUiInstances();
    const source = { identity: "source", generation: 1 };
    const first = owner.open(binding, source);
    const second = owner.open({ ...binding, ownerWebContentsId: 2 }, source);
    expect(first.appIdentity).toBe(second.appIdentity);
    expect(first.token).not.toBe(second.token);
    expect(second.generation).toBeGreaterThan(first.generation);
    owner.close(first);
    const scope = { ...binding, workspace: { workspacePath: "unused", workspaceIdentity: " w " } };
    expect(owner.validate(second, scope, source).lease).toEqual(second);
    expect(() =>
      owner.validate(
        second,
        { ...scope, workspace: { workspacePath: "w", workspaceIdentity: "different" } },
        source,
      ),
    ).toThrow();
  });
  it("account change revokes old credentials and keeps new storage identity isolated", () => {
    const owner = new McpUiInstances();
    const source = { identity: "source", generation: 1 };
    const first = owner.open({ ...binding, accountContext: "account-a" }, source);
    const scope = { ...binding, workspace: { workspacePath: "w" } };
    const signal = owner.validate(first, scope, source).cancel.signal;
    const second = owner.open({ ...binding, accountContext: "account-b" }, source);
    expect(signal.aborted).toBe(true);
    expect(first.appIdentity).not.toBe(second.appIdentity);
    expect(owner.close(first)).toBe(false);
    expect(owner.validate(second, scope, source).lease).toEqual(second);
  });
});

it("a forged scope or stale generation cannot revoke a valid instance", () => {
  const owner = new McpUiInstances();
  const source = { identity: "source", generation: 1 };
  const lease = owner.open(binding, source);
  const scope = { ...binding, workspace: { workspacePath: "w" } };
  const signal = owner.validate(lease, scope, source).cancel.signal;
  expect(() => owner.validate(lease, { ...scope, serverName: "forged" }, null)).toThrow();
  expect(() => owner.validate({ ...lease, generation: 0 }, scope, null)).toThrow();
  expect(signal.aborted).toBe(false);
  expect(owner.validate(lease, scope, source).lease).toEqual(lease);
  expect(() => owner.validate(lease, scope, null)).toThrow();
  expect(signal.aborted).toBe(true);
});
