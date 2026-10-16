import { jsonSchema, streamText, tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestProviderConfigFixture } from "./test-provider-config.js";

describe("OpenAI-compatible stream usage requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("always requests stream usage", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        [
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    });

    const registry = new TestProviderConfigFixture({
      env: {},
      providers: {
        compatible: {
          apiKey: "test-key",
          baseURL: "https://api.example.test/v1",
          kind: "openai-compatible",
        },
      },
    });
    const result = streamText({
      model: registry.resolve("compatible/test-model").model,
      prompt: "hello",
    });

    await expect(result.text).resolves.toBe("ok");
    expect(capturedBody?.stream_options).toEqual({ include_usage: true });
    await expect(result.usage).resolves.toMatchObject({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
    });
  });

  it("preserves a nonstandard max_tokens raw reason when normalized finish is other", async () => {
    vi.stubGlobal("fetch", async () => {
      return new Response(
        [
          'data: {"id":"chatcmpl-max-tokens","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-max-tokens","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"max_tokens"}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    });

    // 修复原因：此断言遗漏了旧 Registry 测试替身迁移；保持真实请求和 raw reason 断言不变。
    const registry = new TestProviderConfigFixture({
      env: {},
      providers: {
        compatible: {
          apiKey: "test-key",
          baseURL: "https://api.example.test/v1",
          kind: "openai-compatible",
        },
      },
    });
    const result = streamText({
      model: registry.resolve("compatible/test-model").model,
      prompt: "continue",
    });

    await expect(result.text).resolves.toBe("partial");
    await expect(result.finishReason).resolves.toBe("other");
    await expect(result.rawFinishReason).resolves.toBe("max_tokens");
  });

  it("keeps parsable partial tool input open until the response stream flushes", async () => {
    vi.stubGlobal("fetch", async () => {
      return new Response(
        [
          'data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Count","arguments":"1"}}]},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"0"}}]},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-tool","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
        { headers: { "content-type": "text/event-stream" } },
      );
    });

    const registry = new TestProviderConfigFixture({
      env: {},
      providers: {
        compatible: {
          apiKey: "test-key",
          baseURL: "https://api.example.test/v1",
          kind: "openai-compatible",
        },
      },
    });
    const result = streamText({
      model: registry.resolve("compatible/test-model").model,
      prompt: "count",
      tools: {
        Count: tool({
          description: "Return a count",
          inputSchema: jsonSchema<number>({ type: "number" }),
        }),
      },
    });

    const toolParts = [];
    for await (const part of result.fullStream) {
      if (
        part.type === "tool-input-start" ||
        part.type === "tool-input-delta" ||
        part.type === "tool-input-end" ||
        part.type === "tool-call"
      ) {
        toolParts.push(part);
      }
    }

    expect(toolParts.map((part) => part.type)).toEqual([
      "tool-input-start",
      "tool-input-delta",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
    ]);
    expect(toolParts.filter((part) => part.type === "tool-input-delta")).toMatchObject([
      { delta: "1" },
      { delta: "0" },
    ]);
    expect(toolParts.at(-1)).toMatchObject({
      input: 10,
      toolCallId: "call_1",
      toolName: "Count",
      type: "tool-call",
    });
  });
});
