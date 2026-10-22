import { expect, it } from "vitest";
import { type Model, type ModelToolContract } from "@zcode/contracts";
import { createTestRuntimeModel } from "./test-runtime-model.js";
import { buildToolExposure, buildToolSearchAnnouncement } from "../src/tool/search/exposure.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { webFetchToolEntry } from "../src/tool/handlers/webfetch.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { todoWriteToolEntry } from "../src/tool/handlers/todo.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { collectDiscoveredTools } from "../src/tool/search/history.js";

const model = (enabled: boolean): Model => ({
  ...createTestRuntimeModel({
    generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
  }),
  requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: enabled } },
});

it("keeps enabled search call/result pairing when every reference in a result becomes unavailable", () => {
  const registry = createToolRegistry();
  [toolSearchToolEntry, webFetchToolEntry, todoWriteToolEntry].forEach((entry) =>
    registry.register(entry),
  );
  const tools = registry.toContracts();
  const entries: RuntimeMessageEntry[] = [
    {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "search-removed", name: "ToolSearch", input: { query: "select:WebFetch" } },
        ],
      },
    },
    {
      message: {
        role: "tool",
        toolName: "ToolSearch",
        toolCallId: "search-removed",
        content: [{ type: "tool_reference", toolName: "WebFetch" }],
      },
    },
  ];
  const before = structuredClone(entries);
  const projected = buildToolExposure({
    mode: "native" as const,
    model: model(true),
    registry,
    entries,
    tools: tools.filter((tool) => tool.name !== "WebFetch"),
  });

  expect(projected.enabled).toBe(true);
  expect(projected.context.catalog.map((tool) => tool.name)).toEqual(["ToolSearch", "TodoWrite"]);
  expect(projected.tools.map((tool) => tool.name)).toEqual(["ToolSearch"]);
  expect(projected.entries).toHaveLength(2);
  expect(projected.entries[0]).toEqual(entries[0]);
  expect(projected.entries[1]).toMatchObject({
    message: {
      role: "tool",
      toolName: "ToolSearch",
      toolCallId: "search-removed",
      content: [{ type: "text", text: "[Tool references removed - tools no longer available]" }],
    },
  });
  expect(entries).toEqual(before);
  expect([...collectDiscoveredTools(entries)]).toEqual(["WebFetch"]);
  const restored = buildToolExposure({
    mode: "native" as const,
    model: model(true),
    registry,
    entries,
    tools,
  });
  expect(restored.entries).toEqual(before);
  expect(restored.tools.find((tool) => tool.name === "WebFetch")).toMatchObject({
    deferLoading: true,
  });
});

it("projects current definitions and removes inaccessible references without changing raw history", () => {
  const registry = createToolRegistry();
  [toolSearchToolEntry, webFetchToolEntry, readToolEntry].forEach((entry) =>
    registry.register(entry),
  );
  const tools = registry.toContracts();
  const entries: RuntimeMessageEntry[] = [
    {
      message: {
        role: "tool",
        toolName: "ToolSearch",
        toolCallId: "real",
        content: [{ type: "tool_reference", toolName: "WebFetch" }],
      },
    },
  ];
  const on = buildToolExposure({
    mode: "native" as const,
    model: model(true),
    tools,
    registry,
    entries,
  });
  expect(on.tools.find((tool) => tool.name === "WebFetch")?.deferLoading).toBe(true);
  const off = buildToolExposure({
    mode: "off" as const,
    model: model(false),
    tools,
    registry,
    entries: [
      ...entries,
      buildToolSearchAnnouncement({
        mode: "native" as const,
        model: model(true),
        tools,
        registry,
        entries,
      })!,
    ],
  });
  expect(off.tools.map((tool) => tool.name)).toEqual(["WebFetch", "Read"]);
  expect(off.entries).toHaveLength(1);
  expect(JSON.stringify(off)).not.toContain('"tool_reference"');
  const changed = tools.map((tool) =>
    tool.name === "WebFetch"
      ? { ...tool, description: "new schema", inputSchema: { type: "object", required: ["new"] } }
      : tool,
  ) as ModelToolContract[];
  expect(
    buildToolExposure({
      mode: "native" as const,
      model: model(true),
      tools: changed,
      registry,
      entries,
    }).tools.find((tool) => tool.name === "WebFetch")?.description,
  ).toBe("new schema");
  const denied = buildToolExposure({
    mode: "native" as const,
    model: model(true),
    tools: tools.filter((tool) => tool.name !== "WebFetch"),
    registry,
    entries,
  });
  expect(denied.enabled).toBe(false);
  expect(denied.context.catalog.map((tool) => tool.name)).not.toContain("WebFetch");
  expect(entries[0]?.message.content).toEqual([{ type: "tool_reference", toolName: "WebFetch" }]);
});

it("collects announcements from retained history independently of request projection", () => {
  const registry = createToolRegistry();
  [toolSearchToolEntry, webFetchToolEntry, readToolEntry].forEach((entry) =>
    registry.register(entry),
  );
  const input = {
    mode: "native" as const,
    model: model(true),
    tools: registry.toContracts(),
    registry,
    entries: [],
  };
  const announcement = buildToolSearchAnnouncement(input)!;
  expect(announcement.content)
    .toBe(`The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:
WebFetch`);
  expect(announcement.metadata?.toolSearchAnnouncement).toEqual({
    addedNames: ["WebFetch"],
    removedNames: [],
    readdedNames: [],
  });
  expect(input.entries).toEqual([]);
  const entries = [announcement];
  expect(buildToolSearchAnnouncement({ ...input, entries })).toBeUndefined();
  expect(
    buildToolSearchAnnouncement({ ...input, mode: "off" as const, model: model(false) }),
  ).toBeUndefined();
  expect(
    buildToolSearchAnnouncement({
      ...input,
      tools: input.tools.filter((t) => t.name !== "ToolSearch"),
    }),
  ).toBeUndefined();
  const projected = buildToolExposure({ ...input, entries });
  expect(projected.entries).toEqual(entries);
  expect(projected).not.toHaveProperty("announcement");
  expect(buildToolExposure(input).entries).toEqual([]);
});

it("rebuilds complete name listings from retained deltas, including a readded-only suffix", () => {
  const registry = createToolRegistry();
  [toolSearchToolEntry, webFetchToolEntry, todoWriteToolEntry].forEach((t) => registry.register(t));
  const tools = registry.toContracts();
  const collect = (entries: RuntimeMessageEntry[], names = ["WebFetch", "TodoWrite"]) =>
    buildToolSearchAnnouncement({
      mode: "native" as const,
      model: model(true),
      registry,
      entries,
      tools: tools.filter((t) => t.name === "ToolSearch" || names.includes(t.name)),
    });
  const first = collect([], ["WebFetch"])!;
  const second = collect([first])!;
  expect(second.metadata?.toolSearchAnnouncement).toEqual({
    addedNames: ["TodoWrite"],
    removedNames: [],
    readdedNames: [],
  });
  expect(second.content).not.toContain("WebFetch");
  const rebuilt = collect([second])!;
  expect(rebuilt.metadata?.toolSearchAnnouncement).toEqual({
    addedNames: ["WebFetch"],
    removedNames: [],
    readdedNames: [],
  });
  expect(rebuilt.content).toContain("\nWebFetch");
  expect(collect([second, rebuilt])).toBeUndefined();

  const removed = collect([first, second], ["TodoWrite"])!;
  expect(removed.metadata?.toolSearchAnnouncement).toEqual({
    addedNames: [],
    removedNames: ["WebFetch"],
    readdedNames: [],
  });
  const readded = collect([first, second, removed])!;
  expect(readded.metadata?.toolSearchAnnouncement).toEqual({
    addedNames: ["WebFetch"],
    removedNames: [],
    readdedNames: ["WebFetch"],
  });
  expect(readded.content).toBe(
    `1 deferred tool is available again (names announced earlier in this conversation): WebFetch. Load via ToolSearch as before.`,
  );
  expect(collect([first, second, removed, readded])).toBeUndefined();
  const readdedSuffix = collect([readded])!;
  expect(readdedSuffix.metadata?.toolSearchAnnouncement).toEqual({
    addedNames: ["TodoWrite", "WebFetch"],
    removedNames: [],
    readdedNames: [],
  });
  expect(readdedSuffix.content).toContain("\nTodoWrite\nWebFetch");
  expect(collect([readded, readdedSuffix])).toBeUndefined();
});

it.each([30, 31])("renders removal of %i names at the listing threshold", (count) => {
  const registry = createToolRegistry();
  const names = Array.from(
    { length: count },
    (_, i) => `mcp__demo__tool${String(i).padStart(2, "0")}`,
  );
  [toolSearchToolEntry, webFetchToolEntry].forEach((entry) => registry.register(entry));
  for (const name of names) {
    registry.register({ ...webFetchToolEntry, metadata: { ...webFetchToolEntry.metadata, name } });
  }
  const tools = registry.toContracts();
  const first = buildToolSearchAnnouncement({
    mode: "native" as const,
    model: model(true),
    tools,
    registry,
    entries: [],
  })!;
  const removed = buildToolSearchAnnouncement({
    mode: "native" as const,
    model: model(true),
    registry,
    tools: tools.filter((tool) => !names.includes(tool.name)),
    entries: [first],
  })!;
  const expected =
    count === 30
      ? `The following deferred tools are no longer available. Do not search for them — ToolSearch will return no match:\n${names.join("\n")}`
      : "31 deferred tools are no longer available: mcp__demo__* (31). Do not search for them — ToolSearch will return no match.";
  expect(removed.content).toBe(`${expected}

This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.`);
  expect(removed.metadata?.toolSearchAnnouncement?.removedNames).toEqual(names);
});

it("separates added, grouped readded and removed announcement paragraphs", () => {
  const registry = createToolRegistry();
  const names = ["mcp__demo__read", "mcp__demo__write", "mcp__other__read", "TodoWrite"];
  registry.register(toolSearchToolEntry);
  for (const name of [...names, "WebFetch"]) {
    registry.register({ ...webFetchToolEntry, metadata: { ...webFetchToolEntry.metadata, name } });
  }
  const priorNames = [...names, "Gone"];
  const entries: RuntimeMessageEntry[] = [
    {
      message: { role: "user", content: "prior listing" },
      metadata: {
        source: "legacy_synthetic",
        toolSearchAnnouncement: { addedNames: priorNames, readdedNames: [], removedNames: [] },
      },
    },
    {
      message: { role: "user", content: "prior removal" },
      metadata: {
        source: "legacy_synthetic",
        toolSearchAnnouncement: { addedNames: [], readdedNames: [], removedNames: names },
      },
    },
  ];
  const announcement = buildToolSearchAnnouncement({
    mode: "native" as const,
    model: model(true),
    registry,
    tools: registry.toContracts(),
    entries,
  })!;
  expect(announcement.content)
    .toBe(`The following deferred tools are now available via ToolSearch. Their schemas are NOT loaded — calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:
WebFetch

4 deferred tools are available again (names announced earlier in this conversation): mcp__demo__* (2), mcp__other__*, TodoWrite. Load via ToolSearch as before.

The following deferred tools are no longer available. Do not search for them — ToolSearch will return no match:
Gone

This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.`);
  expect(
    buildToolSearchAnnouncement({
      mode: "native" as const,
      model: model(true),
      registry,
      tools: registry.toContracts(),
      entries: [...entries, announcement],
    }),
  ).toBeUndefined();
});

it("does not announce deletion when a deferred tool becomes resident", () => {
  const registry = createToolRegistry();
  [toolSearchToolEntry, webFetchToolEntry, todoWriteToolEntry].forEach((t) => registry.register(t));
  const tools = registry.toContracts();
  const input = { mode: "native" as const, model: model(true), registry, tools, entries: [] };
  const first = buildToolSearchAnnouncement(input)!;
  registry.register(
    { ...webFetchToolEntry, metadata: { ...webFetchToolEntry.metadata, alwaysLoad: true } },
    { silentDuplicateWarning: true },
  );
  expect(buildToolSearchAnnouncement({ ...input, entries: [first] })).toBeUndefined();
  registry.register(webFetchToolEntry, { silentDuplicateWarning: true });
  expect(buildToolSearchAnnouncement({ ...input, entries: [first] })).toBeUndefined();
});

it("disables deferral when ToolSearch is outside the allowed scope and honors alwaysLoad", () => {
  const registry = createToolRegistry();
  registry.register({
    ...webFetchToolEntry,
    metadata: { ...webFetchToolEntry.metadata, alwaysLoad: true },
  });
  registry.register(toolSearchToolEntry);
  const exposed = buildToolExposure({
    mode: "native" as const,
    model: model(true),
    tools: registry.toContracts(),
    registry,
    entries: [],
  });
  expect(exposed.reason).toBe("no_deferred_tools");
  expect(exposed.tools[0]?.name).toBe("WebFetch");
  const scoped = buildToolExposure({
    mode: "native" as const,
    model: model(true),
    tools: [webFetchToolEntry].map((entry) => ({
      name: entry.metadata.name,
      inputSchema: entry.inputSchema,
    })),
    entries: [],
  });
  expect(scoped.enabled).toBe(false);
});
