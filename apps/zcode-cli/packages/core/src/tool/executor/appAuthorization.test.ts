import type { McpPort, PermissionBrokerResult, SessionEvent } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import { createMcpAppProvidedToolEntry } from "../../mcp/app-tools.js";
import { createMcpToolEntry } from "../../mcp/index.js";
import { PermissionService, defaultPermissionConfig } from "../../permission/service.js";
import { ToolRegistryImpl } from "../registry.js";
import { ToolExecutorImpl } from "./impl.js";

const descriptor = {
  name: "edit",
  serverName: "fixture",
  toolName: "edit",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
};
const entry = () => createMcpToolEntry("mcp__fixture__edit", descriptor, {} as McpPort, false);
describe("MCP App host authorization", () => {
  it("applies existing deny rules even to a read-only annotated app-only tool absent from the registry", async () => {
    const tool = entry();
    const broker = vi.fn();
    const executor = new ToolExecutorImpl({
      registry: new ToolRegistryImpl(),
      permissionService: new PermissionService({
        ...defaultPermissionConfig,
        disallowedTools: new Set([tool.metadata.name]),
      }),
      permissionBroker: { requestPermission: broker },
      sessionId: "fixture" as never,
      emitEvent: async () => {},
    });
    await expect(
      executor.authorizeAppTool({ id: "call", name: tool.metadata.name, input: {} }, tool),
    ).rejects.toThrow();
    expect(broker).not.toHaveBeenCalled();
  });
  it("rejects approval completed after instance cancellation", async () => {
    const pending = Promise.withResolvers<PermissionBrokerResult>();
    const entered = Promise.withResolvers<void>();
    const cancel = new AbortController();
    const tool = entry();
    const events: SessionEvent[] = [];
    const executor = new ToolExecutorImpl({
      registry: new ToolRegistryImpl(),
      permissionService: new PermissionService(),
      sessionId: "fixture" as never,
      emitEvent: async (event) => {
        events.push(event);
      },
      permissionBroker: {
        requestPermission: () => {
          entered.resolve();
          return pending.promise;
        },
      },
    });
    const authorization = executor.authorizeAppTool(
      { id: "call", name: tool.metadata.name, input: {} },
      tool,
      { signal: cancel.signal },
    );
    const rejected = expect(authorization).rejects.toThrow();
    await entered.promise;
    cancel.abort();
    pending.resolve({ decision: "allow" });
    await rejected;
    expect(events.some((event) => event.type === "permission_requested")).toBe(true);
  });
  it("retains a model target before approval and releases it when cancellation wins", async () => {
    const pending = Promise.withResolvers<PermissionBrokerResult>();
    const entered = Promise.withResolvers<void>();
    const cancel = new AbortController();
    const release = vi.fn();
    const retain = vi.fn(() => ({ signal: cancel.signal, release }));
    const execute = vi.fn();
    const tool = createMcpAppProvidedToolEntry(
      {
        modelName: "app__fixture__edit",
        pluginId: "fixture",
        serverName: "fixture",
        scopeId: "one",
        generation: 1,
        toolName: "edit",
        inputSchema: { type: "object" },
        retainExecution: retain,
      },
      execute,
    );
    const registry = new ToolRegistryImpl();
    registry.register(tool);
    const executor = new ToolExecutorImpl({
      registry,
      permissionService: new PermissionService(),
      sessionId: "fixture" as never,
      emitEvent: async () => {},
      permissionBroker: {
        requestPermission: () => {
          entered.resolve();
          return pending.promise;
        },
      },
    });
    const result = executor.execute({ id: "call", name: tool.metadata.name, input: {} });
    await entered.promise;
    expect(retain).toHaveBeenCalledExactlyOnceWith("call");
    cancel.abort();
    pending.resolve({ decision: "allow" });
    await result;
    expect(execute).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});
