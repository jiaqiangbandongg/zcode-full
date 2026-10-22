import { expect, it, vi } from "vitest";
import { createSessionId, createTurnId, type ToolSearchExecutionContext } from "@zcode/contracts";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { webFetchToolEntry } from "../src/tool/handlers/webfetch.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { collectDiscoveredTools } from "../src/tool/search/history.js";

it("executes concurrent searches only within the request snapshot and cancellation yields no references", async () => {
  const registry = createToolRegistry();
  const fetch = vi.fn();
  registry.register(toolSearchToolEntry);
  registry.register({ ...webFetchToolEntry, handler: fetch });
  const executor = createToolExecutor({
    emitEvent: async () => {},
    registry,
    permissionService: new PermissionService(defaultPermissionConfig),
    sessionId: createSessionId("search-execution"),
    turnId: createTurnId("turn"),
  });
  const toolSearch: ToolSearchExecutionContext = {
    enabled: true,
    mode: "native",
    discovered: new Set(),
    catalog: [{ name: "WebFetch", deferred: true }],
  };
  const results = await executor.executeBatch(
    [
      { id: "one", name: "ToolSearch", input: { query: "select:WebFetch" } },
      { id: "two", name: "ToolSearch", input: { query: "select:WebFetch" } },
    ],
    { toolSearch },
  );
  expect(results).toHaveLength(2);
  for (const result of results)
    expect(result).toMatchObject({
      success: true,
      modelContent: [{ type: "tool_reference", toolName: "WebFetch" }],
    });
  expect(fetch).not.toHaveBeenCalled();
  const excluded = await executor.execute(
    { id: "excluded", name: "ToolSearch", input: { query: "select:WebFetch" } },
    { toolSearch: { ...toolSearch, catalog: [] } },
  );
  expect(excluded.modelContent).toBe("No matching deferred tools found");
  const defaultResults = await executor.execute(
    { id: "default-count", name: "ToolSearch", input: { query: "lookup" } },
    {
      toolSearch: {
        ...toolSearch,
        catalog: Array.from({ length: 6 }, (_, i) => ({ name: `Lookup${i}`, deferred: true })),
      },
    },
  );
  expect(defaultResults).toMatchObject({
    success: true,
    output: { matches: ["Lookup0", "Lookup1", "Lookup2", "Lookup3", "Lookup4"] },
  });
  const cancelled = await executor.execute(
    { id: "cancelled", name: "ToolSearch", input: { query: "select:WebFetch" } },
    { toolSearch, signal: AbortSignal.abort() },
  );
  expect(cancelled.success).toBe(false);
  expect(JSON.stringify(cancelled)).not.toContain("tool_reference");
  const invalid = await executor.execute(
    { id: "invalid", name: "WebFetch", input: {} },
    { toolSearch },
  );
  expect(invalid.success).toBe(false);
  expect(invalid.modelContent).toContain('call ToolSearch with query "select:WebFetch"');
});

it("allows a valid undiscovered deferred tool call without recording a search discovery", async () => {
  const { executor, fetch } = createExecutionFixture();
  const toolSearch: ToolSearchExecutionContext = {
    enabled: true,
    mode: "native",
    discovered: new Set(),
    catalog: [{ name: "WebFetch", deferred: true }],
  };
  const input = { url: "https://example.com/", prompt: "Summarize the page" };
  const result = await executor.execute({ id: "direct", name: "WebFetch", input }, { toolSearch });

  expect(result).toMatchObject({ success: true });
  expect(fetch).toHaveBeenCalledExactlyOnceWith(input, expect.anything());
  expect(result.modelContent).toContain("Fetched page");
  expect(toolSearch.discovered.size).toBe(0);
  expect([
    ...collectDiscoveredTools([
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "direct", name: "WebFetch", input }],
        },
      },
      {
        message: {
          role: "tool",
          toolCallId: "direct",
          toolName: "WebFetch",
          content: result.modelContent!,
        },
      },
    ]),
  ]).toEqual([]);
});

it("does not suggest searching again when a discovered tool fails input validation", async () => {
  const { executor, fetch } = createExecutionFixture();
  const result = await executor.execute(
    { id: "invalid-discovered", name: "WebFetch", input: {} },
    {
      toolSearch: {
        enabled: true,
        mode: "native",
        discovered: new Set(["WebFetch"]),
        catalog: [{ name: "WebFetch", deferred: true }],
      },
    },
  );

  expect(result.success).toBe(false);
  expect(result.modelContent).toContain("InputValidationError");
  expect(result.modelContent).not.toContain('call ToolSearch with query "select:WebFetch"');
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["disabled", "missing"] as const)(
  "rejects ToolSearch with %s execution context without producing references",
  async (context) => {
    const { executor, fetch } = createExecutionFixture();
    const result = await executor.execute(
      { id: "disabled-search", name: "ToolSearch", input: { query: "select:WebFetch" } },
      context === "missing"
        ? {}
        : {
            toolSearch: {
              enabled: false,
              mode: "off",
              discovered: new Set(),
              catalog: [{ name: "WebFetch", deferred: true }],
            },
          },
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("ToolSearch is not enabled for this request.");
    expect(JSON.stringify(result)).not.toContain("tool_reference");
    expect(fetch).not.toHaveBeenCalled();
  },
);

function createExecutionFixture() {
  const registry = createToolRegistry();
  const fetch = vi.fn(async () => ({
    url: "https://example.com/",
    finalUrl: "https://example.com/",
    status: 200,
    statusText: "OK",
    contentType: "text/plain",
    bytes: 12,
    durationMs: 0,
    result: "Fetched page",
    cacheHit: false,
    redirects: [],
    truncated: false,
  }));
  registry.register(toolSearchToolEntry);
  registry.register({ ...webFetchToolEntry, handler: fetch });
  const executor = createToolExecutor({
    emitEvent: async () => {},
    registry,
    permissionService: new PermissionService({
      ...defaultPermissionConfig,
      allowedTools: new Set(["WebFetch"]),
    }),
    sessionId: createSessionId("search-execution-boundaries"),
    turnId: createTurnId("turn"),
  });
  return { executor, fetch };
}
