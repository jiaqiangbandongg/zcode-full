import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { expect, it } from "vitest";
import { toAiSdkMessages } from "../src/model/transform.js";
import { toAiSdkTools } from "../src/model/tool-transform.js";
import { toolSearchHeaders } from "../src/model/tool-search.js";
import { createSessionId, type Model } from "@zcode/contracts";
import { createTestAgentRuntime } from "../../core/tests/test-agent-runtime.js";
import { createTestModelFactory } from "../../core/tests/test-runtime-model.js";
import { createTestSessionEventStore } from "../../core/tests/test-event-store.js";

it.each([
  { stripMedia: false, large: false },
  { stripMedia: true, large: false },
  { stripMedia: false, large: true },
  { stripMedia: true, large: true },
])(
  "serializes native references and schemas (stripMedia=$stripMedia, large=$large)",
  async ({ stripMedia, large }) => {
    const names = large
      ? Array.from({ length: 2_000 }, (_, i) =>
          `mcp__demo__lookup_${String(i).padStart(4, "0")}_`.padEnd(64, "x"),
        )
      : ["WebFetch"];
    let body: any;
    let headers: Headers | undefined;
    const provider = createAnthropic({
      apiKey: "test",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        headers = new Headers(init?.headers);
        return new Response(
          JSON.stringify({ error: { type: "invalid_request_error", message: "capture" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      },
    });
    const options = { stripMedia, providerKind: "anthropic" as const, toolSearchEnabled: true };
    await expect(
      generateText({
        model: provider("test"),
        maxRetries: 0,
        headers: toolSearchHeaders({ "anthropic-beta": "existing-beta" }, true),
        tools: toAiSdkTools(
          names.map((name) => ({ name, inputSchema: { type: "object" }, deferLoading: true })),
          options,
        ),
        messages: toAiSdkMessages(
          [
            {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "search-1",
                  name: "ToolSearch",
                  input: { query: `select:${names.join(",")}` },
                },
              ],
            },
            {
              role: "tool",
              toolCallId: "search-1",
              toolName: "ToolSearch",
              content: [
                { type: "text", text: "before" },
                ...names.map((toolName) => ({ type: "tool_reference" as const, toolName })),
                { type: "text", text: "after" },
              ],
            },
          ],
          options,
        ),
      }),
    ).rejects.toBeDefined();
    expect(
      body.tools.map((tool: { name: string; defer_loading: boolean }) => ({
        name: tool.name,
        defer_loading: tool.defer_loading,
      })),
    ).toEqual(names.map((name) => ({ name, defer_loading: true })));
    expect(body.messages[1].content[0].content).toEqual([
      { type: "text", text: "before" },
      ...names.map((tool_name) => ({ type: "tool_reference", tool_name })),
      { type: "text", text: "after" },
    ]);
    expect(headers?.get("anthropic-beta")).toContain("advanced-tool-use-2025-11-20");
    expect(headers?.get("anthropic-beta")).toContain("existing-beta");
  },
);

it("keeps one announcement in native Anthropic bodies through continuation and the next input", async () => {
  const bodies: Array<{
    messages: unknown[];
    tools: Array<{ name: string; description: string; input_schema: unknown }>;
  }> = [];
  const provider = createAnthropic({
    apiKey: "test",
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({ error: { type: "invalid_request_error", message: "capture" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    },
  });
  const factory = createTestModelFactory({
    async generateText(request) {
      const options = {
        providerKind: "anthropic" as const,
        toolSearchEnabled: request.toolSearchEnabled,
      };
      await expect(
        generateText({
          model: provider("test"),
          maxRetries: 0,
          headers: toolSearchHeaders(undefined, request.toolSearchEnabled),
          tools: toAiSdkTools(request.tools, options),
          messages: toAiSdkMessages(request.messages, options),
        }),
      ).rejects.toBeDefined();
      return { text: "response", finishReason: bodies.length <= 3 ? "length" : "stop", usage: {} };
    },
  });
  const wrap = (model: Model): Model => ({
    ...model,
    requestCapabilities: { toolSearch: { protocolSupported: true, defaultEnabled: true } },
    bind: (options) => wrap(model.bind(options)),
  });
  const runtime = createTestAgentRuntime(
    createSessionId("toolsearch-continuation-wire"),
    {
      toolSearch: { mode: "native" },
      modelStreaming: "off",
      titleGeneration: { enabled: false },
      toolAllowlist: ["ToolSearch", "WebFetch"],
    },
    { eventStore: createTestSessionEventStore(), modelFactory: (input) => wrap(factory(input)) },
  );
  await runtime.executeTurn("start");
  await runtime.executeTurn("next input");
  expect(bodies).toHaveLength(5);
  for (const body of bodies) {
    expect(
      JSON.stringify(body.messages).split(
        "The following deferred tools are now available via ToolSearch.",
      ),
    ).toHaveLength(2);
    expect(body.tools.map((tool) => tool.name)).toEqual(["ToolSearch"]);
    expect(body.tools[0]?.description)
      .toBe(`Fetches full schema definitions for deferred tools so they can be called.

Deferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block — the same encoding as the tool list at the top of this prompt.

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`);
    expect(body.tools[0]?.input_schema).toMatchObject({
      required: ["query", "max_results"],
      properties: {
        query: {
          description:
            'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.',
        },
        max_results: {
          description: "Maximum number of results to return (default: 5)",
          default: 5,
        },
      },
    });
  }
});
