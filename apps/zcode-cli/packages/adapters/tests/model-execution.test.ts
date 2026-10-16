import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateText, jsonSchema, Output } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicCompatFetch } from "../src/model/anthropic-stream-compat.js";
import {
  ProviderBusinessError,
  createProviderBusinessErrorFetch,
} from "../src/model/model-execution.js";
import { TestProviderConfigFixture } from "./test-provider-config.js";

describe("AI SDK Provider execution", () => {
  it("adds Authorization alongside x-api-key for Anthropic provider requests", async () => {
    const receivedHeaders: http.IncomingHttpHeaders[] = [];
    const endpointRoutingPort = {
      resolve: vi.fn(async (url: string) => ({ routed: false, url })),
    };
    const server = http.createServer((request, response) => {
      receivedHeaders.push(request.headers);
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "msg-test",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });

    try {
      const baseURL = await listenServer(server);
      const registry = new TestProviderConfigFixture({
        endpointRoutingPort,
        env: {},
        providers: {
          anthropic: {
            kind: "anthropic",
            baseURL,
            apiKey: "anthropic-key",
          },
        },
      });

      const resolved = registry.resolve("anthropic/claude-test");

      await expect(generateText({ model: resolved.model, prompt: "hello" })).resolves.toMatchObject(
        { text: "ok" },
      );

      expect(receivedHeaders[0]).toMatchObject({
        authorization: "Bearer anthropic-key",
        "x-api-key": "anthropic-key",
        "anthropic-version": "2023-06-01",
      });
      expect(endpointRoutingPort.resolve).toHaveBeenCalledWith(
        expect.any(String),
        expect.not.objectContaining({ apiKey: expect.any(String) }),
      );
    } finally {
      await closeServer(server);
    }
  });

  it("preserves separate Memory selector user messages in the final Anthropic body", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const server = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      requestBodies.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "request captured" },
        }),
      );
    });

    try {
      const baseURL = await listenServer(server);
      const registry = new TestProviderConfigFixture({
        env: {},
        providers: {
          anthropic: {
            kind: "anthropic",
            baseURL,
            apiKey: "anthropic-key",
          },
        },
      });
      const resolved = registry.resolve("anthropic/claude-fable-5-cc", {
        maxOutputTokens: 256,
      });
      const responseSchema = {
        additionalProperties: false,
        properties: {
          selected_memories: { items: { type: "string" }, type: "array" },
          selected_knowledge_ids: { items: { type: "string" }, type: "array" },
        },
        required: ["selected_memories"],
        type: "object",
      } as const;

      await expect(
        generateText({
          model: resolved.model,
          messages: [
            { role: "user", content: "Available memories:\n- project.md" },
            { role: "user", content: "Select memories relevant to:\nproject policy" },
          ],
          maxOutputTokens: 256,
          maxRetries: 0,
          output: Output.object({ schema: jsonSchema(responseSchema) }),
          providerOptions: {
            anthropic: { structuredOutputMode: "outputFormat" },
          },
        }),
      ).rejects.toThrow("request captured");

      expect(requestBodies[0]?.messages).toEqual([
        {
          role: "user",
          content: [{ type: "text", text: "Available memories:\n- project.md" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "Select memories relevant to:\nproject policy" }],
        },
      ]);
      expect(requestBodies[0]?.output_config).toEqual({
        format: { type: "json_schema", schema: responseSchema },
      });
      expect(requestBodies[0]?.max_tokens).toBe(256);
      expect(requestBodies[0]).not.toHaveProperty("thinking");
    } finally {
      await closeServer(server);
    }
  });

  it("preserves retry headers on provider business errors", async () => {
    let originalResponse: Response | undefined;
    const fetch = createProviderBusinessErrorFetch({
      fetch: async () => {
        originalResponse = new Response(
          JSON.stringify({
            error: {
              code: "1305",
              message: "平台流量限制，请稍后重试",
            },
            request_id: "20260703111207fd2a863001c64c94",
            type: "error",
          }),
          {
            headers: {
              "content-type": "application/json",
              "retry-after": "41",
              "x-should-retry": "true",
            },
            status: 529,
          },
        );
        return originalResponse;
      },
      providerId: "zai",
      providerKind: "anthropic",
    });

    await expect(fetch("https://api.z.ai/api/anthropic/v1/messages")).rejects.toMatchObject({
      providerCode: "1305",
      responseHeaders: {
        "retry-after": "41",
        "x-should-retry": "true",
      },
      responseStatus: 529,
    });
    // 回归 BG26：解析 clone 后抛业务错误时，原始 body 也必须被取消/消费，避免连接池泄漏。
    expect(originalResponse?.bodyUsed).toBe(true);
  });

  it("preserves a stable TLS code when provider fetch rejects with a nested Node TLS error", async () => {
    const tlsCause = Object.assign(
      new Error(
        "self-signed certificate; if the root CA is installed locally, try running Node.js with --use-system-ca",
      ),
      { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
    );
    const fetch = createProviderBusinessErrorFetch({
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: tlsCause });
      },
      providerId: "zai",
      providerKind: "anthropic",
    });

    await expect(fetch("https://api.z.ai/api/anthropic/v1/messages")).rejects.toMatchObject({
      cause: { cause: tlsCause },
      code: "MODEL_TLS_VALIDATION_FAILED",
    });
  });

  it("does not let pending response body cleanup block provider business errors", async () => {
    vi.useFakeTimers();
    try {
      let notifyCleanupStarted!: () => void;
      const cleanupStarted = new Promise<void>((resolve) => {
        notifyCleanupStarted = resolve;
      });
      const response = new Response(
        JSON.stringify({
          error: {
            code: "1305",
            message: "平台流量限制，请稍后重试",
          },
        }),
        {
          headers: { "content-type": "application/json" },
          status: 429,
        },
      );
      const nativeClone = response.clone.bind(response);
      vi.spyOn(response, "clone").mockImplementation(() => {
        const cloned = nativeClone();
        // Response.clone() 会替换原 response 的 body 分支，清理必须覆盖 clone 后的原始分支。
        vi.spyOn(response, "arrayBuffer").mockImplementation(() => {
          notifyCleanupStarted();
          return new Promise<never>(() => undefined);
        });
        return cloned;
      });
      const fetch = createProviderBusinessErrorFetch({
        fetch: async () => response,
        providerId: "zai",
        providerKind: "anthropic",
      });

      const request = fetch("https://api.z.ai/api/anthropic/v1/messages");
      const rejection = expect(request).rejects.toMatchObject({
        message: "平台流量限制，请稍后重试",
        name: "ProviderBusinessError",
        providerCode: "1305",
        responseStatus: 429,
      } satisfies Partial<ProviderBusinessError>);
      await cleanupStarted;
      await vi.advanceTimersByTimeAsync(1_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds the Anthropic v1 API prefix when consuming explicit base URLs", () => {
    const registry = new TestProviderConfigFixture({
      env: {},
      providers: {
        anthropic: {
          kind: "anthropic",
          baseURL: "https://example.test/anthropic",
          apiKey: "secret",
        },
        anthropicV1: {
          kind: "anthropic",
          baseURL: "https://example.test/anthropic/v1/",
          apiKey: "secret",
        },
      },
    });

    const normalized = registry.resolve("anthropic/claude-test").model as unknown as {
      config: { baseURL: string };
    };
    const alreadyVersioned = registry.resolve("anthropicV1/claude-test").model as unknown as {
      config: { baseURL: string };
    };

    expect(normalized.config.baseURL).toBe("https://example.test/anthropic/v1");
    expect(alreadyVersioned.config.baseURL).toBe("https://example.test/anthropic/v1");
  });

  it("turns HTTP 200 success=false provider bodies into business errors", async () => {
    const fetch = createProviderBusinessErrorFetch({
      fetch: async () =>
        new Response(
          JSON.stringify({
            code: 500,
            msg: "404 NOT_FOUND",
            success: false,
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        ),
      providerId: "zai",
      providerKind: "openai-compatible",
    });

    await expect(fetch("https://example.test/v1/chat/completions")).rejects.toMatchObject({
      code: "PROVIDER_BUSINESS_ERROR",
      message: "404 NOT_FOUND",
      name: "ProviderBusinessError",
      providerCode: 500,
      providerId: "zai",
      responseStatus: 200,
      statusCode: 500,
    } satisfies Partial<ProviderBusinessError>);
  });

  it("turns HTTP 200 SSE error events into business errors", async () => {
    const fetch = createProviderBusinessErrorFetch({
      fetch: async () =>
        sseResponse([
          sseFrame("error", {
            error: {
              code: "1311",
              message: "当前订阅套餐暂未开放GLM-5V-Turbo权限",
            },
            request_id: "20260505201906b147bc4aa7cd4e58",
          }),
          "data: [DONE]\n\n",
        ]),
      providerId: "zai",
      providerKind: "openai-compatible",
    });

    const response = await fetch("https://example.test/v1/chat/completions?stream=true");
    let error: unknown;
    try {
      await response.text();
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: "PROVIDER_BUSINESS_ERROR",
      message: "当前订阅套餐暂未开放GLM-5V-Turbo权限",
      name: "ProviderBusinessError",
      providerCode: "1311",
      providerId: "zai",
      providerRequestId: "20260505201906b147bc4aa7cd4e58",
      responseStatus: 200,
    } satisfies Partial<ProviderBusinessError>);
    expect((error as ProviderBusinessError).statusCode).toBeUndefined();
  });

  it("keeps successful provider SSE responses readable", async () => {
    const fetch = createProviderBusinessErrorFetch({
      fetch: async () =>
        sseResponse([
          sseFrame("message", {
            choices: [{ delta: { content: "ok" } }],
            code: 0,
          }),
          "data: [DONE]\n\n",
        ]),
      providerId: "local",
      providerKind: "openai-compatible",
    });

    const response = await fetch("https://example.test/v1/chat/completions?stream=true");

    await expect(response.text()).resolves.toContain('"content":"ok"');
  });

  it("turns non-zero code or error_code provider bodies into business errors", async () => {
    const fetch = createProviderBusinessErrorFetch({
      fetch: async () =>
        new Response(
          JSON.stringify({
            error_code: "model_not_found",
            message: "model does not exist",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        ),
      providerId: "local",
      providerKind: "openai-compatible",
    });

    await expect(fetch("https://example.test/v1/chat/completions")).rejects.toMatchObject({
      message: "model does not exist",
      providerCode: "model_not_found",
      responseStatus: 200,
      statusCode: undefined,
    } satisfies Partial<ProviderBusinessError>);
  });

  it("turns HTTP 403 zcode-plan security verification failures into business errors", async () => {
    const body = JSON.stringify({ code: 3007, msg: "security verify failed" });
    const fetchWithJsonContentType = createProviderBusinessErrorFetch({
      fetch: async () =>
        new Response(body, {
          headers: { "content-type": "application/json" },
          status: 403,
        }),
      providerId: "account:zai-individual-coding-plan",
      providerKind: "openai-compatible",
    });
    const fetchWithoutContentType = createProviderBusinessErrorFetch({
      fetch: async () =>
        new Response(body, {
          headers: { "content-length": String(body.length) },
          status: 403,
        }),
      providerId: "account:zai-individual-coding-plan",
      providerKind: "openai-compatible",
    });

    await expect(
      fetchWithJsonContentType("https://example.test/v1/chat/completions"),
    ).rejects.toMatchObject({
      code: "PROVIDER_BUSINESS_ERROR",
      message: "security verify failed",
      providerCode: 3007,
      responseStatus: 403,
    } satisfies Partial<ProviderBusinessError>);
    await expect(
      fetchWithoutContentType("https://example.test/v1/chat/completions"),
    ).rejects.toMatchObject({
      code: "PROVIDER_BUSINESS_ERROR",
      message: "security verify failed",
      providerCode: 3007,
      responseStatus: 403,
    } satisfies Partial<ProviderBusinessError>);
  });

  it("keeps successful provider JSON responses readable", async () => {
    const body = {
      choices: [{ message: { content: "ok" } }],
      code: 0,
      success: true,
    };
    const fetch = createProviderBusinessErrorFetch({
      fetch: async () =>
        new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      providerId: "local",
      providerKind: "openai-compatible",
    });

    const response = await fetch("https://example.test/v1/chat/completions");

    await expect(response.json()).resolves.toEqual(body);
  });

  it("routes provider fetch through explicit ZCODE_HTTP_PROXY env", async () => {
    const proxyRequests: string[] = [];
    const upstream = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ path: request.url, success: true }));
    });
    const proxy = http.createServer((clientRequest, clientResponse) => {
      proxyRequests.push(clientRequest.url ?? "");
      if (!clientRequest.url) {
        clientResponse.writeHead(400);
        clientResponse.end();
        return;
      }

      const target = new URL(clientRequest.url);
      const upstreamRequest = http.request(
        {
          headers: clientRequest.headers,
          hostname: target.hostname,
          method: clientRequest.method,
          path: `${target.pathname}${target.search}`,
          port: target.port,
        },
        (upstreamResponse) => {
          clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(clientResponse);
        },
      );
      upstreamRequest.once("error", (error) => {
        clientResponse.writeHead(502, { "content-type": "text/plain" });
        clientResponse.end(String(error));
      });
      clientRequest.pipe(upstreamRequest);
    });

    try {
      const upstreamBaseUrl = await listenServer(upstream);
      const proxyBaseUrl = await listenServer(proxy);
      const fetch = createProviderBusinessErrorFetch({
        env: {
          ZCODE_HTTP_PROXY: proxyBaseUrl,
        },
        providerId: "local",
        providerKind: "openai-compatible",
      });

      const response = await fetch(`${upstreamBaseUrl}/v1/chat/completions?stream=true`, {
        headers: { "content-type": "application/json" },
        method: "POST",
        body: JSON.stringify({ model: "glm-5.1" }),
      });

      await expect(response.json()).resolves.toEqual({
        path: "/v1/chat/completions?stream=true",
        success: true,
      });
      expect(proxyRequests).toEqual([`${upstreamBaseUrl}/v1/chat/completions?stream=true`]);
    } finally {
      await closeServer(proxy);
      await closeServer(upstream);
    }
  });

  it("bypasses provider proxy when explicit noProxy matches target host", async () => {
    const proxyRequests: string[] = [];
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ direct: true, success: true }));
    });
    const proxy = http.createServer((request, response) => {
      proxyRequests.push(request.url ?? "");
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: false }));
    });

    try {
      const upstreamBaseUrl = await listenServer(upstream);
      const proxyBaseUrl = await listenServer(proxy);
      const fetch = createProviderBusinessErrorFetch({
        env: {
          ZCODE_HTTP_PROXY: proxyBaseUrl,
        },
        noProxy: "127.0.0.1",
        providerId: "local",
        providerKind: "openai-compatible",
      });

      const response = await fetch(`${upstreamBaseUrl}/v1/chat/completions`, {
        headers: { "content-type": "application/json" },
        method: "POST",
        body: JSON.stringify({ model: "glm-5.1" }),
      });

      await expect(response.json()).resolves.toEqual({ direct: true, success: true });
      expect(proxyRequests).toEqual([]);
    } finally {
      await closeServer(proxy);
      await closeServer(upstream);
    }
  });
});

describe("createAnthropicCompatFetch", () => {
  it("filters assistant-side bare tool_result content blocks from Anthropic SSE", async () => {
    const fetch = createAnthropicCompatFetch(async () =>
      sseResponse([
        sseFrame("message_start", {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "glm-5.1",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
        sseFrame("content_block_start", {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text", text: "" },
        }),
        sseFrame("content_block_delta", {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "Output already summarized" },
        }),
        sseFrame("content_block_stop", { type: "content_block_stop", index: 1 }),
        sseFrame("content_block_start", {
          type: "content_block_start",
          index: 2,
          content_block: {
            type: "server_tool_use",
            id: "call_image",
            name: "analyze_image",
            input: {},
          },
        }),
        sseFrame("content_block_stop", { type: "content_block_stop", index: 2 }),
        sseFrame("content_block_start", {
          type: "content_block_start",
          index: 4,
          content_block: {
            type: "tool_result",
            tool_use_id: "call_image",
            content: '["您尚未登录"]',
          },
        }),
        sseFrame("content_block_stop", { type: "content_block_stop", index: 4 }),
        sseFrame("content_block_start", {
          type: "content_block_start",
          index: 5,
          content_block: { type: "text", text: "" },
        }),
        sseFrame("content_block_delta", {
          type: "content_block_delta",
          index: 5,
          delta: { type: "text_delta", text: "The image says 您尚未登录." },
        }),
      ]),
    );

    const response = await fetch("https://example.test/v1/messages");
    const text = await response.text();

    expect(text).toContain('"type":"server_tool_use"');
    expect(text).toContain("Output already summarized");
    expect(text).toContain("The image says");
    expect(text).not.toContain('"type":"tool_result"');
    expect(text).not.toContain('"index":4');
  });

  it("keeps typed Anthropic tool result blocks", async () => {
    const fetch = createAnthropicCompatFetch(async () =>
      sseResponse([
        sseFrame("content_block_start", {
          type: "content_block_start",
          index: 3,
          content_block: {
            type: "web_search_tool_result",
            tool_use_id: "srv_1",
            content: [
              {
                type: "web_search_result",
                url: "https://example.test",
                title: "Example",
                encrypted_content: "opaque",
              },
            ],
          },
        }),
        sseFrame("content_block_stop", { type: "content_block_stop", index: 3 }),
      ]),
    );

    const response = await fetch("https://example.test/v1/messages");
    const text = await response.text();

    expect(text).toContain('"type":"web_search_tool_result"');
    expect(text).toContain('"index":3');
  });

  it("synthesizes a signature delta for thinking signatures delivered at block start", async () => {
    const start = sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "sig_start" },
    });
    const thinking = sseFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "internal trace" },
    });
    const stop = sseFrame("content_block_stop", { type: "content_block_stop", index: 0 });
    const fetch = createAnthropicCompatFetch(async () => sseResponse([start, thinking, stop]));

    const response = await fetch("https://example.test/v1/messages");

    await expect(response.text()).resolves.toBe(
      [
        start,
        thinking,
        sseFrame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig_start" },
        }),
        stop,
      ].join(""),
    );
  });

  it("does not duplicate a native signature delta", async () => {
    const frames = [
      sseFrame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "sig_start" },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig_native" },
      }),
      sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    ];
    const fetch = createAnthropicCompatFetch(async () => sseResponse(frames));

    const response = await fetch("https://example.test/v1/messages");

    await expect(response.text()).resolves.toBe(frames.join(""));
  });

  it("synthesizes start-delivered signatures across fragmented CRLF frames", async () => {
    const separator = "\r\n\r\n";
    const start = sseFrame(
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "sig_crlf" },
      },
      separator,
    );
    const stop = sseFrame(
      "content_block_stop",
      { type: "content_block_stop", index: 0 },
      separator,
    );
    const wire = `${start}${stop}`;
    const separatorSplit = start.indexOf(separator) + separator.length - 1;
    const fetch = createAnthropicCompatFetch(async () =>
      chunkedSseResponse([
        wire.slice(0, separatorSplit),
        wire.slice(separatorSplit, start.length + 7),
        wire.slice(start.length + 7),
      ]),
    );

    const response = await fetch("https://example.test/v1/messages");

    await expect(response.text()).resolves.toBe(
      [
        start,
        sseFrame(
          "content_block_delta",
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "sig_crlf" },
          },
          separator,
        ),
        stop,
      ].join(""),
    );
  });

  it("flushes a final stop frame without a trailing SSE separator", async () => {
    const start = sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "sig_final" },
    });
    const stop = `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: 0,
    })}`;
    const fetch = createAnthropicCompatFetch(async () =>
      chunkedSseResponse([start, stop.slice(0, 11), stop.slice(11)]),
    );

    const response = await fetch("https://example.test/v1/messages");

    await expect(response.text()).resolves.toBe(
      [
        start,
        sseFrame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig_final" },
        }),
        stop,
      ].join(""),
    );
  });

  it("drops unsigned thinking blocks from JSON message responses", async () => {
    const body = JSON.stringify({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "glm-0606",
      content: [
        { type: "thinking", thinking: "internal trace" },
        { type: "text", text: "Visible answer" },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const fetch = createAnthropicCompatFetch(
      async () =>
        new Response(body, {
          headers: {
            "content-length": String(body.length),
            "content-type": "application/json",
          },
        }),
    );

    const response = await fetch("https://example.test/v1/messages");
    const parsed = (await response.json()) as {
      content: Array<{ type: string; text?: string; thinking?: string }>;
    };

    expect(parsed.content).toEqual([{ type: "text", text: "Visible answer" }]);
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("keeps signed thinking blocks in JSON message responses", async () => {
    const body = JSON.stringify({
      content: [
        { type: "thinking", thinking: "trusted trace", signature: "sig_1" },
        { type: "text", text: "Visible answer" },
      ],
    });
    const fetch = createAnthropicCompatFetch(
      async () =>
        new Response(body, {
          headers: {
            "content-length": String(body.length),
            "content-type": "application/json",
          },
        }),
    );

    const response = await fetch("https://example.test/v1/messages");

    await expect(response.text()).resolves.toBe(body);
    expect(response.headers.get("content-length")).toBe(String(body.length));
  });

  it.each([
    ["an empty string signature", { signature: "" }],
    ["redacted data", { redactedData: "opaque-redacted-thinking" }],
  ])("keeps JSON thinking blocks carrying %s", async (_label, metadata) => {
    const body = JSON.stringify({
      content: [
        { type: "thinking", thinking: "trusted trace", ...metadata },
        { type: "text", text: "Visible answer" },
      ],
    });
    const fetch = createAnthropicCompatFetch(
      async () =>
        new Response(body, {
          headers: {
            "content-length": String(body.length),
            "content-type": "application/json",
          },
        }),
    );

    const response = await fetch("https://example.test/v1/messages");

    await expect(response.text()).resolves.toBe(body);
    expect(response.headers.get("content-length")).toBe(String(body.length));
  });

  it("does not rewrite unrelated JSON responses", async () => {
    const body = JSON.stringify({
      type: "content_block_start",
      content_block: { type: "tool_result" },
    });
    const fetch = createAnthropicCompatFetch(
      async () =>
        new Response(body, {
          headers: {
            "content-length": String(body.length),
            "content-type": "application/json",
          },
        }),
    );

    const response = await fetch("https://example.test/v1/messages");

    await expect(response.text()).resolves.toBe(body);
    expect(response.headers.get("content-length")).toBe(String(body.length));
  });

  it("keeps non-JSON SSE frames readable", async () => {
    const fetch = createAnthropicCompatFetch(async () =>
      sseResponse(["event: comment\ndata: not-json\n\n"]),
    );

    const response = await fetch("https://example.test/v1/messages");

    await expect(response.text()).resolves.toBe("event: comment\ndata: not-json\n\n");
  });
});

async function listenServer(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }

  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function sseFrame(event: string, data: unknown, separator = "\n\n"): string {
  const lineEnding = separator === "\r\n\r\n" ? "\r\n" : separator === "\r\r" ? "\r" : "\n";
  return `event: ${event}${lineEnding}data: ${JSON.stringify(data)}${separator}`;
}

function sseResponse(frames: string[]): Response {
  const body = frames.join("");
  return new Response(body, {
    headers: {
      "content-length": String(body.length),
      "content-type": "text/event-stream; charset=utf-8",
    },
  });
}

function chunkedSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
      },
    },
  );
}
