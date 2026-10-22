import { expect, it } from "vitest";
import { createSessionId, type Model, type ModelRequest } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { prepareRuntimeProviderRequest } from "../src/runtime/helpers/runtime-provider-request-messages.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { webFetchToolEntry } from "../src/tool/handlers/webfetch.js";
import { createTestModelFactory, createTestRuntimeModel } from "./test-runtime-model.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";

function fixture(defaultEnabled = true, protocolSupported = true) {
  const registry = createToolRegistry();
  [readToolEntry, toolSearchToolEntry, webFetchToolEntry].forEach((entry) =>
    registry.register(entry),
  );
  const model: Model = {
    ...createTestRuntimeModel({
      generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
    }),
    requestCapabilities: { toolSearch: { defaultEnabled, protocolSupported } },
  };
  return { model, registry, tools: registry.toContracts() };
}

function history(): RuntimeMessageEntry[] {
  return [
    {
      message: { role: "user", content: "Fetch the documentation." },
      metadata: { source: "real_user" },
    },
    {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "search-real", name: "ToolSearch", input: { query: "select:WebFetch" } }],
      },
    },
    {
      message: {
        role: "tool",
        toolName: "ToolSearch",
        toolCallId: "search-real",
        content: [{ type: "tool_reference", toolName: "WebFetch" }],
      },
    },
    {
      message: { role: "user", content: "old tool announcement" },
      metadata: {
        source: "legacy_synthetic",
        toolSearchAnnouncement: { addedNames: ["WebFetch"], removedNames: [], readdedNames: [] },
      },
    },
  ];
}

it("prepares a scoped request without collecting announcements", () => {
  const input = fixture();
  const entries: RuntimeMessageEntry[] = [
    { message: { role: "user", content: "Start" }, metadata: { source: "real_user" } },
  ];
  const prepared = prepareRuntimeProviderRequest(
    { config: { toolSearch: { mode: "auto" } } },
    { ...input, entries, prompt: "Summarize", applyCacheControl: true, skipCacheWrite: true },
  );
  expect(prepared.request.toolSearchEnabled).toBe(true);
  expect(prepared.request.tools.map((tool) => tool.name)).toEqual(["Read", "ToolSearch"]);
  expect(prepared.toolSearch.catalog.find((tool) => tool.name === "WebFetch")?.deferred).toBe(true);
  expect(prepared.request.messages.at(-1)?.content).toBe("Summarize");
  expect(JSON.stringify(prepared.request.messages)).not.toContain("schemas are NOT loaded");
  expect(prepared).not.toHaveProperty("announcement");
  expect(entries).toHaveLength(1);
});

it.each(["goal", "memory"])(
  "automatically downgrades %s requests without ToolSearch and preserves call pairing and raw history",
  (kind) => {
    const input = fixture();
    const entries = history();
    const before = structuredClone(entries);
    const tools = kind === "goal" ? [] : input.tools.filter((tool) => tool.name !== "ToolSearch");
    const prepared = prepareRuntimeProviderRequest(
      { config: { toolSearch: { mode: "auto" } } },
      { ...input, tools, entries },
    );
    expect(prepared.request.toolSearchEnabled).toBe(false);
    expect(prepared.request.tools.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
    expect(prepared.request.tools.every((tool) => tool.deferLoading === undefined)).toBe(true);
    expect(prepared.request.messages.find((message) => message.role === "tool")).toMatchObject({
      toolCallId: "search-real",
      content: [{ type: "text", text: "[Tool references removed - tool search not enabled]" }],
    });
    expect(
      prepared.request.messages.some((message) =>
        message.toolCalls?.some((call) => call.id === "search-real"),
      ),
    ).toBe(true);
    expect(JSON.stringify(prepared.request.messages)).not.toContain("old tool announcement");
    expect(entries).toEqual(before);
    expect(prepared).not.toHaveProperty("announcement");
  },
);

it("restores definitions from compact metadata before rendering, and filters tools outside the current scope", () => {
  const input = fixture();
  const entries: RuntimeMessageEntry[] = [
    {
      message: { role: "user", content: "Summary" },
      metadata: {
        compactBoundary: {
          boundaryId: "boundary",
          preCompactDiscoveredTools: ["WebFetch", "removed_tool"],
        },
      },
    },
  ];
  const prepared = prepareRuntimeProviderRequest(
    { config: { toolSearch: { mode: "auto" } } },
    { ...input, entries },
  );
  expect(prepared.request.tools.find((tool) => tool.name === "WebFetch")?.deferLoading).toBe(true);
  expect(prepared.request.tools.some((tool) => tool.name === "removed_tool")).toBe(false);
  expect(JSON.stringify(prepared.request.messages)).not.toContain("preCompactDiscoveredTools");
  expect(entries[0]?.metadata?.compactBoundary?.preCompactDiscoveredTools).toEqual([
    "WebFetch",
    "removed_tool",
  ]);
});

it("rebuilds on/off/on from the original snapshot without accumulating announcements or losing references", () => {
  const input = fixture();
  const entries = history();
  const on = prepareRuntimeProviderRequest(
    { config: { toolSearch: { mode: "auto" } } },
    { ...input, entries },
  );
  const off = prepareRuntimeProviderRequest(
    { config: { toolSearch: { mode: "auto" } } },
    { ...input, model: fixture(false).model, entries },
  );
  const restored = prepareRuntimeProviderRequest(
    { config: { toolSearch: { mode: "auto" } } },
    { ...input, entries },
  );
  expect(off.request.toolSearchEnabled).toBe(false);
  expect(JSON.stringify(off.request.messages)).not.toContain('"tool_reference"');
  expect(restored.request).toEqual(on.request);
  expect(restored).not.toHaveProperty("announcement");
});

it("preserves force validation even for an empty tool catalog", () => {
  const input = fixture(false, false);
  expect(() =>
    prepareRuntimeProviderRequest(
      { config: { toolSearch: { mode: "native" } } },
      { ...input, tools: [], entries: [] },
    ),
  ).toThrow(/Anthropic Messages/);
});

it.each<{
  scenario: string;
  mcpCount: number;
  searchAllowed?: boolean;
  alwaysLoad?: boolean;
  defaultEnabled?: boolean;
  force?: boolean;
  expectedEnabled?: boolean;
  expectedToolCount: number;
}>([
  {
    scenario: "denied search above threshold",
    mcpCount: 101,
    searchAllowed: false,
    expectedToolCount: 0,
  },
  {
    scenario: "denied search below threshold",
    mcpCount: 1,
    searchAllowed: false,
    expectedToolCount: 3,
  },
  {
    scenario: "always-loaded MCP above threshold",
    mcpCount: 99,
    alwaysLoad: true,
    expectedToolCount: 0,
  },
  {
    scenario: "always-loaded MCP at threshold",
    mcpCount: 98,
    alwaysLoad: true,
    expectedToolCount: 100,
  },
  { scenario: "no deferred compact candidates", mcpCount: 0, expectedToolCount: 2 },
  {
    scenario: "ordinary provider above threshold",
    mcpCount: 101,
    defaultEnabled: false,
    expectedToolCount: 0,
  },
  {
    scenario: "Coding Plan search available",
    mcpCount: 101,
    expectedEnabled: true,
    expectedToolCount: 2,
  },
  {
    scenario: "forced search available",
    mcpCount: 101,
    defaultEnabled: false,
    force: true,
    expectedEnabled: true,
    expectedToolCount: 2,
  },
])(
  "selects compact tools using actual ToolSearch availability: $scenario",
  async ({
    scenario,
    mcpCount,
    searchAllowed = true,
    alwaysLoad = false,
    defaultEnabled = true,
    force = false,
    expectedEnabled = false,
    expectedToolCount,
  }) => {
    const registry = createToolRegistry();
    for (let index = 0; index < mcpCount; index++) {
      registry.register({
        inputSchema: { type: "object", properties: {} },
        metadata: {
          name: `mcp__demo__tool${index}`,
          mcpPresentation: { serverName: "demo", toolName: `tool${index}` },
          alwaysLoad,
          readOnly: true,
          concurrentSafe: true,
          destructive: false,
          needsApproval: false,
          riskLevel: "low",
          sideEffectScope: "none",
        },
        handler: async () => "done",
      });
    }
    const compactRequests: ModelRequest[] = [];
    let initialRequest: ModelRequest | undefined;
    const modelFactory = createTestModelFactory({
      async generateText(request) {
        const compact = JSON.stringify(request.messages.at(-1)?.content).includes(
          "create a detailed summary",
        );
        if (compact) compactRequests.push(request);
        else initialRequest ??= request;
        return {
          text: compact ? "<summary>Continue the task.</summary>" : "done",
          finishReason: "stop",
          usage: {},
        };
      },
    });
    const wrap = (model: Model): Model => ({
      ...model,
      requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled } },
      bind: (options) => wrap(model.bind(options)),
    });
    const runtime = createTestAgentRuntime(
      createSessionId(`compact-toolsearch-${scenario}`),
      {
        modelStreaming: "off",
        titleGeneration: { enabled: false },
        toolAllowlist: ["Read", "Write", "ToolSearch"],
        toolDisallowlist: searchAllowed ? [] : ["ToolSearch"],
        toolSearch: { mode: force ? "native" : "auto" },
      },
      {
        toolRegistry: registry,
        eventStore: createTestSessionEventStore(),
        modelFactory: (input) => wrap(modelFactory(input)),
      },
    );
    await runtime.executeTurn("First setup turn");
    await runtime.executeTurn("Second setup turn");
    await runtime.executeTurn("/compact");

    expect(compactRequests).toHaveLength(1);
    const request = compactRequests[0]!;
    expect(request.toolSearchEnabled).toBe(expectedEnabled);
    expect(request.tools).toHaveLength(expectedToolCount);
    expect(request.tools?.some((tool) => tool.name === "ToolSearch")).toBe(expectedEnabled);
    if (expectedEnabled) {
      expect(request.tools?.map((tool) => tool.name).sort()).toEqual(["Read", "ToolSearch"]);
    } else {
      expect(request.tools).toEqual(expectedToolCount ? initialRequest?.tools : []);
      expect(JSON.stringify(request.messages)).not.toContain("schemas are NOT loaded");
      expect(request.tools?.every((tool) => tool.deferLoading === undefined)).toBe(true);
    }
  },
);
