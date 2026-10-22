import { describe, expect, it, vi } from "vitest";
import { createSessionId, createTurnId, type ToolSearchMode } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { deferredToolCallEntry } from "../src/tool/handlers/deferred-tool-call.js";
import { buildToolSearchAnnouncement } from "../src/tool/search/exposure.js";
import { prepareRuntimeProviderRequest } from "../src/runtime/helpers/runtime-provider-request-messages.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";
import { searchTools } from "../src/tool/search/search.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";

const ref = (toolName: string) => ({ type: "tool_reference" as const, toolName });
function batch(id: string, names: string[]): RuntimeMessageEntry[] {
  return [
    {
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id, name: "ToolSearch", input: { query: `select:${names.join(",")}` } }],
      },
    },
    { message: { role: "tool", toolName: "ToolSearch", toolCallId: id, content: names.map(ref) } },
  ];
}
function checkpoint(names: string[]): RuntimeMessageEntry {
  return {
    message: { role: "user", content: "summary" },
    metadata: { compactBoundary: { boundaryId: "boundary", preCompactDiscoveredTools: names } },
  };
}
function fixture() {
  const registry = createToolRegistry();
  const handler = vi.fn(async (input) => input);
  registry.register(toolSearchToolEntry);
  registry.register(deferredToolCallEntry);
  for (const name of ["A", "B", "Resident"])
    registry.register({
      ...toolSearchToolEntry,
      metadata: {
        ...toolSearchToolEntry.metadata,
        name,
        description: `unique ${name} capability`,
        shouldDefer: name !== "Resident",
      },
      aliases: [`alias_${name}`],
      inputSchema: {
        type: "object",
        properties: { value: { type: "number" } },
        required: ["value"],
      },
      runtimeInputSchema: undefined,
      outputSchema: {},
      runtimeOutputSchema: undefined,
      formatModelContent: undefined,
      handler,
    });
  const model = {
    ...createTestRuntimeModel({
      generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
    }),
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
  };
  const input = (entries: RuntimeMessageEntry[]) => ({
    entries,
    registry,
    model,
    tools: registry.toContracts(),
  });
  const prepare = (entries: RuntimeMessageEntry[], mode: ToolSearchMode = "local") =>
    prepareRuntimeProviderRequest({ config: { toolSearch: { mode } } }, input(entries));
  return { registry, handler, prepare, input };
}
function resultText(prepared: ReturnType<ReturnType<typeof fixture>["prepare"]>, id: string) {
  return JSON.stringify(
    prepared.request.messages.find(
      (message) => message.role === "tool" && message.toolCallId === id,
    )?.content,
  );
}

function loadedReminder(names: string[]): string {
  const action = names.length === 1 ? "Call it now" : "Call them now";
  return `<system-reminder>\nLoaded: ${names.join(", ")}. ${action} with DeferredToolCall {"name":"<tool name>","input":{...}}, using the exact tool name and filling input according to its schema above. No additional ToolSearch is needed before calling these tools.\n</system-reminder>`;
}

describe("Local search per-result feedback", () => {
  it.each([false, true])("keeps wrapped reminders inside results with MCS=%s", (mcs) => {
    const { input } = fixture();
    const history = [
      ...batch("first", ["A"]),
      ...batch("mixed", ["A", "B"]),
      ...batch("repeat", ["A", "B"]),
    ];
    const original = structuredClone(history);
    const requestInput = input(history);
    const { request } = prepareRuntimeProviderRequest(
      { config: { toolSearch: { mode: "local" } } },
      {
        ...requestInput,
        model: {
          ...requestInput.model,
          properties: { ...requestInput.model.properties, supportsMidConversationSystem: mcs },
        },
      },
    );
    for (const id of ["mixed", "repeat"]) {
      const result = request.messages.find((message) => message.toolCallId === id)!;
      const blocks = result.content as Array<{ type: string; text: string }>;
      expect(result.role).toBe("tool");
      const reminder = blocks.at(-1)!.text;
      expect(reminder).toMatch(/^<system-reminder>\nTool definitions already available/);
      expect(reminder).toMatch(/Searching again does not execute them\.\n<\/system-reminder>$/);
      expect(reminder.match(/<system-reminder>/g)).toHaveLength(1);
      expect(blocks.filter((block) => block.text.startsWith("<functions>"))).toHaveLength(
        id === "mixed" ? 1 : 0,
      );
    }
    expect(request.messages.filter((message) => message.content === "Tool loaded.")).toHaveLength(
      0,
    );
    expect(request.messages.some((message) => message.role === "system")).toBe(false);
    for (const [id, names] of [
      ["first", ["A"]],
      ["mixed", ["B"]],
    ] as const) {
      const blocks = request.messages.find((message) => message.toolCallId === id)!.content;
      expect(blocks).toContainEqual({ type: "text", text: loadedReminder([...names]) });
    }
    expect(history).toEqual(original);
  });

  it.each([
    { loaded: [], names: ["A"], fresh: ["A"] },
    { loaded: [], names: ["B", "A", "B"], fresh: ["B", "A"] },
    { loaded: ["A"], names: ["A", "B"], fresh: ["B"] },
    { loaded: ["A", "B"], names: ["A", "B"], fresh: [] },
    { loaded: [], names: ["Resident", "A", "missing"], fresh: ["A"] },
    { loaded: [], names: ["Resident"], fresh: [] },
    { loaded: [], names: ["missing"], fresh: [] },
    { loaded: [], names: [], fresh: [] },
  ])(
    "adds one calling hint only for newly expanded deferred tools: $names",
    ({ loaded, names, fresh }) => {
      const { prepare } = fixture();
      const history = [...(loaded.length ? batch("first", loaded) : []), ...batch("next", names)];
      const original = structuredClone(history);
      const prepared = prepare(history);
      const result = prepared.request.messages.find((message) => message.toolCallId === "next")!;
      const blocks = result.content as Array<{ type: string; text: string }>;
      const reminders = blocks.filter((block) =>
        block.text.startsWith("<system-reminder>\nLoaded: "),
      );
      expect(reminders).toEqual(
        fresh.length ? [{ type: "text", text: loadedReminder(fresh) }] : [],
      );
      if (fresh.length) {
        const reminderIndex = blocks.indexOf(reminders[0]!);
        expect(
          blocks.slice(reminderIndex + 1).some((block) => block.text.includes("<functions>")),
        ).toBe(false);
        expect(
          blocks.slice(0, reminderIndex).some((block) => block.text.includes("</functions>")),
        ).toBe(true);
      }
      expect(prepare(history).request).toEqual(prepared.request);
      expect(history).toEqual(original);
    },
  );

  it.each([
    { loaded: [], names: ["A", "B"], schemas: 2, reminder: [] },
    { loaded: ["A"], names: ["A", "B"], schemas: 1, reminder: ["A"] },
    { loaded: ["A", "B"], names: ["A", "B"], schemas: 0, reminder: ["A", "B"] },
    { loaded: ["Resident"], names: ["Resident"], schemas: 1, reminder: [] },
    { loaded: ["B"], names: ["Resident", "B"], schemas: 1, reminder: ["B"] },
  ])("projects $loaded -> $names", ({ loaded, names, schemas, reminder }) => {
    const { prepare } = fixture();
    const history = [...(loaded.length ? batch("first", loaded) : []), ...batch("next", names)];
    const original = structuredClone(history);
    const projected = prepare(history);
    const text = resultText(projected, "next");
    expect(text.match(/<function>/g) ?? []).toHaveLength(schemas);
    expect(text.match(/<functions>/g) ?? []).toHaveLength(schemas ? 1 : 0);
    expect(projected.loadedToolCallIds.size).toBe(0);
    expect(projected.request.messages.filter((m) => m.content === "Tool loaded.")).toHaveLength(0);
    if (reminder.length) {
      expect(text).toContain("already available");
      expect(text).toContain("DeferredToolCall");
      for (const name of reminder) expect(text).not.toContain(`\\"name\\":\\"${name}\\"`);
    } else expect(text).not.toContain("already available");
    expect(history).toEqual(original);
  });

  it("keeps earlier feedback stable across other tools, user input and later discoveries", () => {
    const { prepare } = fixture();
    const initial = batch("first", ["A"]);
    const prior = prepare(initial);
    const entries: RuntimeMessageEntry[] = [
      ...initial,
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "other", name: "Resident", input: {} }],
        },
      },
      { message: { role: "tool", toolName: "Resident", toolCallId: "other", content: "done" } },
      { message: { role: "user", content: "Search again" }, metadata: { source: "real_user" } },
      ...batch("again", ["A"]),
      ...batch("new", ["B"]),
    ];
    const next = prepare(entries);
    expect(next.request.messages.slice(0, prior.request.messages.length)).toEqual(
      prior.request.messages,
    );
    expect(next.request.tools).toEqual(prior.request.tools);
    expect(resultText(next, "again")).not.toContain("<functions>");
    expect(next.loadedToolCallIds.size).toBe(0);
  });

  it("compares parallel searches against the same pre-batch context", () => {
    const { prepare } = fixture();
    const left = batch("left", ["A"]),
      right = batch("right", ["A", "B"]);
    left[0]!.message.toolCalls!.push(...right[0]!.message.toolCalls!);
    const prepared = prepare([left[0]!, left[1]!, right[1]!, ...batch("after", ["A", "B"])]);
    expect(resultText(prepared, "left")).toContain("<functions>");
    expect(resultText(prepared, "right").match(/<function>/g)).toHaveLength(2);
    expect(resultText(prepared, "after")).not.toContain("<functions>");
    expect(prepared.loadedToolCallIds.size).toBe(0);
  });

  it("preserves hook order, merges reminders once, and never counts hook text as a schema", () => {
    const { prepare } = fixture();
    const next = batch("next", ["A", "B"]);
    next[1]!.message.content = [
      { type: "text", text: "BEFORE" },
      ref("A"),
      ref("B"),
      { type: "text", text: "AFTER" },
      ref("A"),
    ];
    const projected = prepare([...batch("first", ["A"]), ...next]);
    const text = resultText(projected, "next");
    expect(text.indexOf("BEFORE")).toBeLessThan(text.indexOf("<functions>"));
    expect(text.indexOf("</functions>")).toBeLessThan(text.indexOf("AFTER"));
    expect(text.match(/already available/g)).toHaveLength(1);
    expect(text.indexOf("AFTER")).toBeLessThan(text.indexOf("Loaded: B."));
    expect(text.match(/Loaded: B\./g)).toHaveLength(1);
    next[1]!.message.content = [
      ref("A"),
      { type: "text", text: "<functions><function>Hook text</function></functions>" },
    ];
    expect(prepare([...batch("first", ["A"]), ...next]).loadedToolCallIds.has("next")).toBe(false);
    expect(resultText(prepare([...batch("first", ["A"]), ...next]), "next")).not.toContain(
      "Loaded:",
    );
  });

  it("does not learn failed references, and keeps Native/Off feedback unchanged", () => {
    const { prepare, registry } = fixture();
    const failed = batch("failed", ["A"]);
    failed[1]!.message.isError = true;
    expect(resultText(prepare(failed), "failed")).not.toContain("Loaded:");
    expect(resultText(prepare([...failed, ...batch("next", ["A"])]), "next")).toContain(
      "Loaded: A.",
    );
    const repeated = [...batch("first", ["A"]), ...batch("next", ["A"])];
    expect([...prepare(repeated, "native").loadedToolCallIds]).toEqual(["first", "next"]);
    expect(prepare(repeated, "off").loadedToolCallIds.size).toBe(0);
    for (const mode of ["native", "off"] as const)
      expect(JSON.stringify(prepare(repeated, mode).request.messages)).not.toContain("Loaded:");
    registry.unregister("A");
    const unavailable = prepare(repeated);
    expect(unavailable.loadedToolCallIds.size).toBe(0);
    expect(resultText(unavailable, "next")).toContain("tools no longer available");
  });
});

describe("Local checkpoint promotion", () => {
  it("shares resident classification across exposure, search, announcements and wrapper admission", async () => {
    const { prepare, registry, handler, input } = fixture();
    const entries = [checkpoint(["A", "B", "missing"]), ...batch("select", ["A", "B"])];
    const prepared = prepare(entries);
    expect(prepared.toolSearch.mode).toBe("local");
    expect(prepared.request.tools?.map((t) => t.name)).toEqual([
      "ToolSearch",
      "DeferredToolCall",
      "A",
      "B",
      "Resident",
    ]);
    expect(prepared.request.tools?.some((t) => t.deferLoading)).toBe(false);
    expect(prepared.toolSearch.catalog.filter((t) => t.deferred)).toEqual([]);
    expect(resultText(prepared, "select").match(/<function>/g)).toHaveLength(2);
    expect(resultText(prepared, "select")).not.toContain("Loaded:");
    expect(searchTools("unique capability", prepared.toolSearch.catalog)).toEqual([]);
    expect(searchTools("select:alias_A,B", prepared.toolSearch.catalog)).toEqual(["A", "B"]);
    expect(buildToolSearchAnnouncement({ ...input(entries), mode: "local" })).toBeUndefined();
    const executor = createToolExecutor({
      registry,
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      sessionId: createSessionId("promoted"),
      turnId: createTurnId("turn"),
      getMode: () => "yolo",
    });
    const wrapped = await executor.execute(
      { id: "call", name: "DeferredToolCall", input: { name: "A", input: { value: 1 } } },
      { toolSearch: prepared.toolSearch },
    );
    expect(wrapped.success).toBe(false);
    expect(JSON.stringify(wrapped)).toContain("directly");
    expect(handler).not.toHaveBeenCalled();
    expect(
      (
        await executor.execute(
          { id: "direct", name: "A", input: { value: 1 } },
          { toolSearch: prepared.toolSearch },
        )
      ).success,
    ).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(registry.get("A")?.metadata.shouldDefer).toBe(true);
  });

  it("promotes only checkpoint names and honors scope, mode and removed tools", () => {
    const { prepare, registry, input } = fixture();
    const entries = [checkpoint(["A"]), ...batch("new", ["B"])];
    const local = prepare(entries);
    expect(local.request.tools?.map((t) => t.name)).toContain("A");
    expect(local.request.tools?.map((t) => t.name)).not.toContain("B");
    expect(
      buildToolSearchAnnouncement({ ...input(entries), mode: "local" })?.metadata
        ?.toolSearchAnnouncement?.addedNames,
    ).toEqual(["B"]);
    expect(
      prepare(entries, "native")
        .request.tools?.filter((t) => t.deferLoading)
        .map((t) => t.name),
    ).toEqual(["A", "B"]);
    expect(prepare(entries, "off").request.tools?.map((t) => t.name)).toEqual([
      "A",
      "B",
      "Resident",
    ]);
    const scoped = input(entries);
    scoped.tools = scoped.tools.filter((t) => t.name !== "A");
    expect(
      prepareRuntimeProviderRequest(
        { config: { toolSearch: { mode: "local" } } },
        scoped,
      ).request.tools?.map((t) => t.name),
    ).not.toContain("A");
    registry.unregister("A");
    expect(prepare(entries).request.tools?.map((t) => t.name)).not.toContain("A");
    registry.unregister("DeferredToolCall");
    expect(prepare(entries).toolSearch.mode).toBe("off");
  });
});
