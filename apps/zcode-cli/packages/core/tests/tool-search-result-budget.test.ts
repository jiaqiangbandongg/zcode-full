import { expect, it } from "vitest";
import {
  createSessionId,
  createTurnId,
  modelMessageContentToText,
  type ModelMessageContentBlock,
} from "@zcode/contracts";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { toolSearchToolEntry } from "../src/tool/handlers/tool-search.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { collectDiscoveredTools } from "../src/tool/search/history.js";
import { completedToolPartMetadata } from "../src/runtime/methods/tool-part-metadata.js";
import { createInMemoryHookRunner } from "../src/hooks/index.js";

const catalog = Array.from({ length: 2_000 }, (_, i) => ({
  name: `mcp__demo__lookup_${String(i).padStart(4, "0")}_`.padEnd(64, "x"),
  description: "lookup information",
  deferred: true,
}));

it.each([
  { query: "lookup", max_results: 5, count: 5 },
  { query: "lookup", max_results: -1, count: 1_999 },
  { query: "lookup", max_results: 0, count: 0 },
  { query: "lookup", max_results: 1.5, count: 1 },
  { query: "lookup", max_results: 1_000_000, count: 2_000 },
  { query: `select:${catalog.map((tool) => tool.name).join(",")}`, max_results: 1, count: 2_000 },
])(
  "preserves $count references with max_results=$max_results",
  async ({ query, max_results, count }) => {
    const result = await execute({ query, max_results });
    expect(result.success).toBe(true);
    const names = catalog.slice(0, count).map((tool) => tool.name);
    const expected = names.map((toolName) => ({ type: "tool_reference", toolName }));
    expect(result.modelContent).toEqual(count ? expected : "No matching deferred tools found");
    expect(result.serialization?.truncated).toBe(false);
    expect(completedToolPartMetadata(result).modelContent).toEqual(count ? expected : undefined);
    expect([
      ...collectDiscoveredTools([
        {
          message: {
            role: "tool",
            toolCallId: result.toolCallId,
            toolName: "ToolSearch",
            content: result.modelContent!,
          },
        },
      ]),
    ]).toEqual(names);
  },
);

it("keeps all references and counts the final content after an oversized Hook", async () => {
  const result = await execute({ query: "lookup", max_results: -1 }, "说明".repeat(60_000));
  expect(result.success).toBe(true);
  expect(Array.isArray(result.modelContent)).toBe(true);
  const blocks = result.modelContent as ModelMessageContentBlock[];
  expect(blocks.filter((block) => block.type === "tool_reference")).toEqual(
    catalog.slice(0, -1).map((tool) => ({ type: "tool_reference", toolName: tool.name })),
  );
  const text = modelMessageContentToText(blocks.filter((block) => block.type === "text"));
  expect(text).toContain("[Hook additional context]");
  expect(text).toContain("truncated");
  expect(text).not.toContain("\uFFFD");
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(100_000);
  const content = modelMessageContentToText(blocks);
  expect(result.serialization).toMatchObject({
    content,
    returnedBytes: Buffer.byteLength(content),
    truncated: true,
  });
  expect(result.serialization!.returnedBytes).toBeGreaterThan(100_000);
  expect(completedToolPartMetadata(result).modelContent).toEqual(blocks);
});

it.each(["head", "tail"] as const)(
  "preserves interleaved block order when clipping %s text",
  async (direction) => {
    const blocks: ModelMessageContentBlock[] = [
      { type: "text", text: "first" },
      { type: "tool_reference", toolName: "WebFetch" },
      { type: "text", text: "中".repeat(100) },
      { type: "tool_reference", toolName: "TodoWrite" },
      { type: "text", text: "last" },
    ];
    const original = structuredClone(blocks);
    const result = await execute({ query: "lookup", max_results: 1 }, undefined, blocks, direction);
    expect(Array.isArray(result.modelContent)).toBe(true);
    const projected = result.modelContent as ModelMessageContentBlock[];
    expect(projected.filter((b) => b.type === "tool_reference")).toEqual([blocks[1], blocks[3]]);
    if (direction === "head") expect(projected[0]).toEqual(blocks[0]);
    else expect(projected.slice(0, -1).at(-1)).toEqual(blocks[4]);
    const text = modelMessageContentToText(projected.filter((b) => b.type === "text"));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(80);
    expect(text).toContain("truncated");
    expect(blocks).toEqual(original);
  },
);

async function execute(
  input: { query: string; max_results: number },
  hookText?: string,
  content?: ModelMessageContentBlock[],
  direction: "head" | "tail" = "head",
) {
  const registry = createToolRegistry();
  registry.register(
    content
      ? {
          ...toolSearchToolEntry,
          formatModelContent: () => content,
          resultBudget: {
            maxInlineBytes: 80,
            maxModelBytes: 80,
            strategy: "truncate",
            preview: { direction },
          },
        }
      : toolSearchToolEntry,
  );
  const executor = createToolExecutor({
    registry,
    emitEvent: async () => {},
    permissionService: new PermissionService(defaultPermissionConfig),
    sessionId: createSessionId("search-budget"),
    turnId: createTurnId("turn"),
    ...(hookText
      ? {
          hookRunner: createInMemoryHookRunner({
            hooks: [
              {
                event: "PostToolUse",
                matcher: "ToolSearch",
                callback: async (hook) => ({
                  hookSpecificOutput: {
                    hookEventName: hook.hookEventName,
                    additionalContext: hookText,
                  },
                }),
              },
            ],
          }),
        }
      : {}),
  });
  return executor.execute(
    { id: "search", name: "ToolSearch", input },
    {
      toolSearch: { enabled: true, mode: "native", catalog, discovered: new Set() },
    },
  );
}
