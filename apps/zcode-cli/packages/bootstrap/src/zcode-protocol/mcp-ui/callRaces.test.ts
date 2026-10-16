import type { McpAppProvidedToolDefinition, McpAppProvidedToolExecutor } from "@zcode/core";
import type { McpAppsAppToolCallRequest } from "@zcode/shared/mcp-apps";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpUiAppToolRegistry } from "./appTools.js";
import { createExampleSessionAccess } from "./contract.example.js";
import { abortMcpUiToolCallsForSession, createMcpUiHandlers } from "./handlers.js";
const scope = {
  sessionId: "race",
  pluginId: "p",
  serverName: "plugin:example-plugin:widget",
  instance: { runtimeId: "agent", generation: 1, token: "token", appIdentity: "a".repeat(64) },
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
afterEach(() => abortMcpUiToolCallsForSession(scope.sessionId));
describe("page to MCP cancellation", () => {
  it("cancels before admission without executing", async () => {
    const handlers = createMcpUiHandlers();
    const access = createExampleSessionAccess();
    const execute = vi.fn(async () => ({ content: [] }));
    access.callTool = execute;
    await handlers.cancelToolCall(access, { ...scope, callId: "early" });
    await expect(
      handlers.callTool(access, { ...scope, callId: "early", toolName: "test" }),
    ).rejects.toThrow("Duplicate");
    expect(execute).not.toHaveBeenCalled();
  });
  it("cancels while visibility/admission is pending, rejecting the late result", async () => {
    const gate = deferred<readonly ("app" | "model")[]>();
    const entered = deferred<void>();
    const access = createExampleSessionAccess();
    access.getToolVisibility = () => {
      entered.resolve();
      return gate.promise;
    };
    const execute = vi.fn(async () => ({ content: [] }));
    access.callTool = execute;
    const handlers = createMcpUiHandlers();
    const pending = handlers.callTool(access, { ...scope, callId: "pending", toolName: "test" });
    const assertion = expect(pending).rejects.toThrow();
    await entered.promise;
    await handlers.cancelToolCall(access, { ...scope, callId: "pending" });
    gate.resolve(["app"]);
    await assertion;
    expect(execute).not.toHaveBeenCalled();
  });
  it("propagates cancellation to execution and refuses a late success or duplicate execution", async () => {
    const result = deferred<{ content: [] }>();
    const entered = deferred<void>();
    let signal: AbortSignal | undefined;
    const access = createExampleSessionAccess();
    access.getToolVisibility = async () => ["app"];
    access.callTool = async (_server, _tool, _args, options) => {
      signal = options?.signal;
      entered.resolve();
      return result.promise;
    };
    const handlers = createMcpUiHandlers();
    const params = { ...scope, callId: "running", toolName: "test" };
    const pending = handlers.callTool(access, params);
    const assertion = expect(pending).rejects.toThrow();
    await entered.promise;
    await handlers.cancelToolCall(access, params);
    expect(signal?.aborted).toBe(true);
    result.resolve({ content: [] });
    await assertion;
    await expect(handlers.callTool(access, params)).rejects.toThrow("Duplicate");
  });
});
describe("model to page cancellation", () => {
  for (const claimed of [false, true])
    it(`has one terminal outcome when cancelled ${claimed ? "after" : "before"} claim`, async () => {
      let execute!: McpAppProvidedToolExecutor;
      let definitions: readonly McpAppProvidedToolDefinition[] = [];
      const messages: McpAppsAppToolCallRequest[] = [];
      const registry = new McpUiAppToolRegistry({
        applyTools: (_session, tools, run) => {
          definitions = tools;
          execute = run;
          return tools.map((t) => t.modelName);
        },
        publishCall: (_session, _target, call) => {
          messages.push(call);
        },
        createCallId: () => "model-call",
      });
      const params = { ...scope, scopeId: scope.instance.token, generation: 1 };
      registry.register({
        ...params,
        tools: [{ name: "increment", inputSchema: { type: "object" } }],
      });
      const cancel = new AbortController();
      const pending = execute(
        { definition: definitions[0]!, arguments: {}, toolCallId: "model" },
        { signal: cancel.signal },
      );
      const assertion = expect(pending).rejects.toThrow("cancelled");
      if (claimed) expect(registry.claim({ ...params, callId: "model-call" })).toBe(true);
      cancel.abort();
      await assertion;
      expect(messages.filter((message) => message.cancelled)).toHaveLength(1);
      expect(registry.resolve({ ...params, callId: "model-call", result: { content: [] } })).toBe(
        false,
      );
      expect(registry.claim({ ...params, callId: "model-call" })).toBe(false);
      registry.clearSession(scope.sessionId);
    });
});
