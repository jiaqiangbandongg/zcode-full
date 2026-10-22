import { expect, it, vi } from "vitest";
import type { ResolvedToolSearchMode } from "@zcode/contracts";
import type { RuntimeMessageMessageEntry } from "../src/agent/message-history.js";
import { buildToolExposure } from "../src/tool/search/exposure.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { deferredToolCallEntry } from "../src/tool/handlers/deferred-tool-call.js";
import { webFetchToolEntry } from "../src/tool/handlers/webfetch.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

function fixture() {
  const registry = createToolRegistry();
  [toolSearchToolEntry, deferredToolCallEntry, webFetchToolEntry].forEach((tool) =>
    registry.register(tool),
  );
  const model = {
    ...createTestRuntimeModel({
      generateText: async () => ({ text: "", finishReason: "stop", usage: {} }),
    }),
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
  };
  const tools = registry.toContracts();
  return { registry, model, tools };
}

function result(
  content: RuntimeMessageMessageEntry["message"]["content"],
): RuntimeMessageMessageEntry {
  return { message: { role: "tool", toolName: "ToolSearch", toolCallId: "search", content } };
}

it.each<ResolvedToolSearchMode>(["native", "local", "off"])(
  "%s reuses unchanged tool result entries and their content",
  (mode) => {
    const entries = [result([{ type: "text", text: "ordinary tool output" }]), result("text")];
    for (const entry of entries) {
      Object.freeze(entry.message.content);
      Object.freeze(entry.message);
      Object.freeze(entry);
    }
    const projected = buildToolExposure({ ...fixture(), mode, entries });
    expect(projected.entries).toHaveLength(entries.length);
    entries.forEach((entry, index) => expect(projected.entries[index]).toBe(entry));
  },
);

it("encodes a Local definition once per request and reads new definitions on the next request", () => {
  const input = fixture();
  const reference = { type: "tool_reference" as const, toolName: "WebFetch" };
  const entries = [result([reference, reference]), result([reference])];
  const stringify = vi.spyOn(JSON, "stringify");
  let first;
  let second;
  let definitions;
  try {
    first = buildToolExposure({ ...input, mode: "local", entries });
    second = buildToolExposure({
      ...input,
      mode: "local",
      entries,
      tools: input.tools.map((tool) =>
        tool.name === "WebFetch" ? { ...tool, description: "updated definition" } : tool,
      ),
    });
    definitions = stringify.mock.calls.filter(([value]) => value?.name === "WebFetch");
  } finally {
    stringify.mockRestore();
  }
  expect(definitions).toHaveLength(2);
  const firstContent = first.entries.map((entry) => JSON.stringify(entry.message.content));
  expect(firstContent[0]?.match(/<functions>/g)).toHaveLength(1);
  expect(firstContent[0]?.match(/<function>/g)).toHaveLength(2);
  expect(firstContent[1]?.match(/<functions>/g)).toHaveLength(1);
  expect(JSON.stringify(first.entries)).not.toContain("updated definition");
  expect(JSON.stringify(second.entries)).toContain("updated definition");
  expect(entries[0]?.message.content).toEqual([reference, reference]);
});

it("preserves Native discovery ordering when an earlier error reference is discovered later", () => {
  const input = fixture();
  const reference = { type: "tool_reference" as const, toolName: "WebFetch" };
  const failed = result([reference]);
  failed.message.isError = true;
  const withoutDiscovery = buildToolExposure({ ...input, mode: "native", entries: [failed] });
  expect(withoutDiscovery.context.discovered.size).toBe(0);
  expect(withoutDiscovery.entries[0]?.message.content).toEqual([
    { type: "text", text: "[Tool references removed - tools no longer available]" },
  ]);
  const successful = result([reference]);
  const discovered = buildToolExposure({
    ...input,
    mode: "native",
    entries: [failed, successful],
  });
  expect(discovered.tools.find((tool) => tool.name === "WebFetch")?.deferLoading).toBe(true);
  expect(discovered.entries[0]).toBe(failed);
  expect(discovered.entries[1]).toBe(successful);
});
