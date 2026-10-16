import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createModelId,
  createModelProviderId,
  createHttpClientError,
  createSessionId,
  createTurnId,
  type HttpClientPort,
  type HttpClientResponse,
  type Model,
  type SessionEvent,
} from "@zcode/contracts";
import {
  clearWebFetchCacheForTests,
  webFetchHandler,
  webFetchToolEntry,
} from "../src/tool/handlers/webfetch.js";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { createTestModelFormatProperties } from "./test-runtime-model.js";

const dnsLookupMock = vi.hoisted(() => vi.fn());

vi.mock("node:dns/promises", () => ({
  lookup: dnsLookupMock,
}));

describe("WebFetch tool", () => {
  beforeEach(() => {
    clearWebFetchCacheForTests();
    dnsLookupMock.mockReset();
    dnsLookupMock.mockRejectedValue(new Error("DNS lookup should not run for WebFetch"));
  });

  it("upgrades explicit http URLs before fetching and answers with the active model", async () => {
    const httpClient = createHttpClient([
      response({
        body: "<html><body><h1>Install</h1><p>Run <strong>zcode</strong>.</p></body></html>",
        url: "https://example.com:12345/docs",
      }),
    ]);
    const model = createTestModel("Use zcode.");

    const output = await webFetchHandler(
      {
        url: "http://example.com:12345/docs",
        prompt: "What should I run?",
      },
      createContext({ httpClient, model }),
    );

    expect(httpClient.request).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: {
          Accept: "text/markdown, text/html, */*",
          "User-Agent": expect.any(String),
        },
        method: "GET",
        redirect: "manual",
        timeoutMs: 60_000,
        url: "https://example.com:12345/docs",
      }),
      expect.any(Object),
    );
    expect(model.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            content: expect.stringContaining("# Install"),
            role: "user",
          }),
        ]),
        tools: [],
      }),
    );
    const processingRequest = vi.mocked(model.generateText).mock.calls[0]?.[0];
    const processingPrompt = processingRequest?.messages
      .map((message) => message.content)
      .join("\n");
    expect(processingPrompt).toContain("Web page content:");
    expect(processingPrompt).toContain("---\n# Install");
    expect(processingPrompt).toContain("\nWhat should I run?\n");
    expect(processingPrompt).toContain(
      "Provide a concise response based only on the content above.",
    );
    expect(processingPrompt).not.toContain(
      "IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs.",
    );
    expect(processingRequest?.options).toEqual({
      maxOutputTokens: 4_096,
      reasoningLevel: "low",
    });
    expect(output).toMatchObject({
      cacheHit: false,
      finalUrl: "https://example.com:12345/docs",
      result: "Use zcode.",
      truncated: false,
      url: "http://example.com:12345/docs",
    });
    expect(webFetchToolEntry.formatModelContent?.(output)).toBe("Use zcode.");
  });

  it("rejects local IP literal URLs before any network request", async () => {
    const httpClient = createHttpClient([]);
    const model = createTestModel("unused");

    await expect(
      webFetchHandler(
        {
          url: "http://127.0.0.1:12345/status",
          prompt: "Summarize",
        },
        createContext({ httpClient, model }),
      ),
    ).rejects.toMatchObject({
      context: {
        hostname: "127.0.0.1",
        webFetchCode: "webfetch_egress_blocked",
      },
    });
    expect(httpClient.request).not.toHaveBeenCalled();
    expect(dnsLookupMock).not.toHaveBeenCalled();
    expect(model.generateText).not.toHaveBeenCalled();
  });

  it("fetches hostname URLs without DNS preflight", async () => {
    const httpClient = createHttpClient([
      response({
        body: "hostname content",
        contentType: "text/plain",
        url: "https://internal.example.com/status",
      }),
    ]);
    const model = createTestModel("hostname answer");

    const output = await webFetchHandler(
      { url: "https://internal.example.com/status", prompt: "Summarize" },
      createContext({ httpClient, model }),
    );

    expect(output.result).toBe("hostname answer");
    expect(dnsLookupMock).not.toHaveBeenCalled();
    expect(getContentRequestCalls(httpClient)).toHaveLength(1);
  });

  it("rejects localhost-style hostnames as invalid URLs before fetching", async () => {
    const httpClient = createHttpClient([]);
    const model = createTestModel("unused");

    await expect(
      webFetchHandler(
        { url: "https://api.localhost/status", prompt: "Summarize" },
        createContext({ httpClient, model }),
      ),
    ).rejects.toMatchObject({
      context: {
        hostname: "api.localhost",
        webFetchCode: "webfetch_invalid_url",
      },
    });
    expect(dnsLookupMock).not.toHaveBeenCalled();
    expect(httpClient.request).not.toHaveBeenCalled();
    expect(model.generateText).not.toHaveBeenCalled();
  });

  it.each([
    ["10.0.0.12", "private IPv4"],
    ["169.254.169.254", "link-local metadata IPv4"],
    ["198.18.0.1", "benchmark IPv4"],
  ])("rejects %s %s literal URLs before fetching", async (address) => {
    const httpClient = createHttpClient([]);
    const model = createTestModel("unused");

    await expect(
      webFetchHandler(
        { url: `https://${address}/status`, prompt: "Summarize" },
        createContext({ httpClient, model }),
      ),
    ).rejects.toMatchObject({
      context: {
        address,
        hostname: address,
        webFetchCode: "webfetch_egress_blocked",
      },
    });
    expect(dnsLookupMock).not.toHaveBeenCalled();
    expect(httpClient.request).not.toHaveBeenCalled();
    expect(model.generateText).not.toHaveBeenCalled();
  });

  it.each([
    ["::1", "loopback IPv6"],
    ["64:ff9b::a9fe:a9fe", "DNS64 metadata IPv6"],
    ["64:ff9b:1::1", "local-use IPv4/IPv6 translation"],
    ["100::1", "IPv6 discard-only"],
    ["2001:2::1", "IPv6 benchmarking"],
    ["2001:10::1", "ORCHIDv1"],
    ["2001:20::1", "ORCHIDv2"],
  ])("rejects %s %s literal URLs before fetching", async (address) => {
    const httpClient = createHttpClient([]);
    const model = createTestModel("unused");
    const urlAddress = `[${address}]`;

    await expect(
      webFetchHandler(
        { url: `https://${urlAddress}/status`, prompt: "Summarize" },
        createContext({ httpClient, model }),
      ),
    ).rejects.toMatchObject({
      context: {
        address,
        hostname: address,
        webFetchCode: "webfetch_egress_blocked",
      },
    });
    expect(dnsLookupMock).not.toHaveBeenCalled();
    expect(httpClient.request).not.toHaveBeenCalled();
    expect(model.generateText).not.toHaveBeenCalled();
  });

  it("allows public IP literal URLs without DNS preflight", async () => {
    const httpClient = createHttpClient([
      response({
        body: "public literal content",
        contentType: "text/plain",
        url: "https://8.8.8.8/dns",
      }),
    ]);
    const model = createTestModel("public literal answer");

    const output = await webFetchHandler(
      { url: "https://8.8.8.8/dns", prompt: "Summarize" },
      createContext({ httpClient, model }),
    );

    expect(output.result).toBe("public literal answer");
    expect(dnsLookupMock).not.toHaveBeenCalled();
    expect(getContentRequestCalls(httpClient)).toHaveLength(1);
  });

  it("emits network request status events for outbound HTTP", async () => {
    const events: SessionEvent[] = [];
    const httpClient = createHttpClient([
      response({
        body: "network content",
        contentType: "text/plain",
        url: "https://example.com/network",
      }),
    ]);
    const model = createTestModel("network answer");

    await webFetchHandler(
      { url: "https://example.com/network", prompt: "Summarize" },
      createContext({
        emitEvent: async (event) => {
          events.push(event);
        },
        httpClient,
        model,
      }),
    );

    const payloads = events.map((event) => event.payload as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual([
      "network_request_status",
      "network_request_status",
    ]);
    expect(payloads[0]).toMatchObject({
      method: "GET",
      source: "http_client",
      status: "pending",
      toolCallId: "webfetch-call",
      toolName: "WebFetch",
      url: "https://example.com/network",
    });
    expect(payloads[1]).toMatchObject({
      durationMs: 5,
      method: "GET",
      source: "http_client",
      status: "complete",
      statusCode: 200,
      toolCallId: "webfetch-call",
      toolName: "WebFetch",
      url: "https://example.com/network",
    });
    expect(payloads[0]?.requestId).toBe(payloads[1]?.requestId);
  });

  it("emits a network error event when WebFetch fails before a response", async () => {
    const events: SessionEvent[] = [];
    const httpClient: HttpClientPort = {
      request: vi.fn<HttpClientPort["request"]>(async () => {
        throw new Error("socket down");
      }),
    };
    const model = createTestModel("unused");

    await expect(
      webFetchHandler(
        { url: "https://example.com/error", prompt: "Summarize" },
        createContext({
          emitEvent: async (event) => {
            events.push(event);
          },
          httpClient,
          model,
        }),
      ),
    ).rejects.toThrow("socket down");

    const payloads = events.map((event) => event.payload as Record<string, unknown>);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({
      status: "pending",
      url: "https://example.com/error",
    });
    expect(payloads[1]).toMatchObject({
      error: "socket down",
      status: "error",
      url: "https://example.com/error",
    });
    expect(payloads[0]?.requestId).toBe(payloads[1]?.requestId);
  });

  it("shows a compact connect timeout cause when WebFetch fails before a response", async () => {
    const events: SessionEvent[] = [];
    const concreteCause = new Error(
      "Connect Timeout Error (attempted address: www.bbc.com:443, timeout: 10000ms)",
    );
    concreteCause.name = "ConnectTimeoutError";
    const fetchCause = new TypeError("fetch failed");
    Object.defineProperty(fetchCause, "cause", {
      configurable: true,
      value: concreteCause,
    });
    const httpClient: HttpClientPort = {
      request: vi.fn<HttpClientPort["request"]>(async (request) => {
        throw createHttpClientError({
          cause: fetchCause,
          code: "network_error",
          message: "fetch failed",
          url: request.url,
        });
      }),
    };
    const model = createTestModel("unused");

    let thrown: unknown;
    try {
      await webFetchHandler(
        { url: "https://www.bbc.com/sport/football/world-cup", prompt: "Summarize" },
        createContext({
          emitEvent: async (event) => {
            events.push(event);
          },
          httpClient,
          model,
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Connect Timeout Error (443, timeout 10000ms)");

    const payloads = events.map((event) => event.payload as Record<string, unknown>);
    expect(payloads[1]).toMatchObject({
      error: "Connect Timeout Error (443, timeout 10000ms)",
      status: "error",
      url: "https://www.bbc.com/sport/football/world-cup",
    });
  });

  it("includes the deepest network error code when a WebFetch request fails", async () => {
    const events: SessionEvent[] = [];
    const resetCause = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    const httpClient: HttpClientPort = {
      request: vi.fn<HttpClientPort["request"]>(async (request) => {
        throw createHttpClientError({
          cause: resetCause,
          code: "proxy_error",
          message: "aborted",
          url: request.url,
        });
      }),
    };
    const model = createTestModel("unused");

    let thrown: unknown;
    try {
      await webFetchHandler(
        { url: "https://www.goal.com/en/world-cup/schedule-results", prompt: "Summarize" },
        createContext({
          emitEvent: async (event) => {
            events.push(event);
          },
          httpClient,
          model,
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("aborted (ECONNRESET)");

    const payloads = events.map((event) => event.payload as Record<string, unknown>);
    expect(payloads[1]).toMatchObject({
      error: "aborted (ECONNRESET)",
      status: "error",
      url: "https://www.goal.com/en/world-cup/schedule-results",
    });
  });

  it("does not retry transient connection resets before failing WebFetch", async () => {
    const events: SessionEvent[] = [];
    const resetCause = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    const httpClient: HttpClientPort = {
      request: vi.fn<HttpClientPort["request"]>(async (request) => {
        throw createHttpClientError({
          cause: resetCause,
          code: "proxy_error",
          message: "aborted",
          url: request.url,
        });
      }),
    };
    const model = createTestModel("unused");

    await expect(
      webFetchHandler(
        {
          url: "https://www.flashscore.com/football/world/world-cup-2026/results/",
          prompt: "Summarize",
        },
        createContext({
          emitEvent: async (event) => {
            events.push(event);
          },
          httpClient,
          model,
        }),
      ),
    ).rejects.toThrow("aborted (ECONNRESET)");

    expect(getContentRequestCalls(httpClient)).toHaveLength(1);
    expect(model.generateText).not.toHaveBeenCalled();
    expect(events.map((event) => (event.payload as Record<string, unknown>).status)).toEqual([
      "pending",
      "error",
    ]);
  });

  it("reuses cached fetched content while still applying the caller prompt", async () => {
    const httpClient = createHttpClient([
      response({
        body: "# Cached\n\nThe answer is in the page.",
        contentType: "text/plain",
        url: "https://example.com/cache",
      }),
    ]);
    const model = createTestModel("cached answer");
    const context = createContext({ httpClient, model });

    const first = await webFetchHandler(
      { url: "https://example.com/cache", prompt: "First prompt" },
      context,
    );
    const second = await webFetchHandler(
      { url: "https://example.com/cache", prompt: "Second prompt" },
      context,
    );

    expect(getContentRequestCalls(httpClient)).toHaveLength(1);
    expect(model.generateText).toHaveBeenCalledTimes(2);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
  });

  it("processes non-preapproved markdown content with the lite model", async () => {
    const httpClient = createHttpClient([
      response({
        body: "# Markdown\n\nThe answer is already readable.",
        contentType: "text/markdown",
        url: "https://example.com/markdown",
      }),
    ]);
    const model = createTestModel("processed markdown");

    const output = await webFetchHandler(
      { url: "https://example.com/markdown", prompt: "Summarize" },
      createContext({ httpClient, model }),
    );

    expect(getContentRequestCalls(httpClient)).toHaveLength(1);
    expect(model.generateText).toHaveBeenCalledTimes(1);
    expect(output).toMatchObject({
      cacheHit: false,
      contentType: "text/markdown",
      finalUrl: "https://example.com/markdown",
      result: "processed markdown",
      truncated: false,
    });
  });

  it("returns preapproved markdown content directly without invoking the lite model", async () => {
    const httpClient = createHttpClient([
      response({
        body: "# Direct markdown\n\nThe answer is already readable.",
        contentType: "text/markdown",
        url: "https://docs.python.org/3/",
      }),
    ]);
    const model = createTestModel("unused");

    const output = await webFetchHandler(
      { url: "https://docs.python.org/3/", prompt: "Summarize" },
      createContext({ httpClient, model }),
    );

    expect(getContentRequestCalls(httpClient)).toHaveLength(1);
    expect(model.generateText).not.toHaveBeenCalled();
    expect(output).toMatchObject({
      cacheHit: false,
      contentType: "text/markdown",
      finalUrl: "https://docs.python.org/3/",
      result: "# Direct markdown\n\nThe answer is already readable.",
      truncated: false,
    });
  });

  it("uses the preapproved processing prompt branch when direct markdown return does not apply", async () => {
    const httpClient = createHttpClient([
      response({
        body: "<html><body><h1>Docs</h1><p>Use pathlib.</p></body></html>",
        contentType: "text/html",
        url: "https://docs.python.org/3/library/pathlib.html",
      }),
    ]);
    const model = createTestModel("pathlib answer");

    await webFetchHandler(
      { url: "https://docs.python.org/3/library/pathlib.html", prompt: "Summarize" },
      createContext({ httpClient, model }),
    );

    const processingRequest = vi.mocked(model.generateText).mock.calls[0]?.[0];
    const processingPrompt = processingRequest?.messages
      .map((message) => message.content)
      .join("\n");
    expect(processingPrompt).toContain(
      "Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.",
    );
    expect(processingPrompt).not.toContain("strict 125-character maximum");
  });

  it("allows same-host redirects modulo www", async () => {
    const httpClient = createHttpClient([
      response({
        headers: { location: "https://www.example.com/final" },
        status: 301,
        statusText: "Moved Permanently",
        url: "https://example.com/start",
      }),
      response({
        body: "final content",
        contentType: "text/plain",
        url: "https://www.example.com/final",
      }),
    ]);
    const model = createTestModel("final answer");

    const output = await webFetchHandler(
      { url: "https://example.com/start", prompt: "Summarize" },
      createContext({ httpClient, model }),
    );

    expect(output.redirects).toEqual([
      {
        from: "https://example.com/start",
        status: 301,
        to: "https://www.example.com/final",
      },
    ]);
    expect(output.finalUrl).toBe("https://www.example.com/final");
  });

  it("returns cross-host redirects as a model-readable tool result", async () => {
    const httpClient = createHttpClient([
      response({
        headers: { location: "https://evil.example/final" },
        status: 302,
        statusText: "Found",
        url: "https://example.com/start",
      }),
    ]);
    const model = createTestModel("unused");

    const output = await webFetchHandler(
      { url: "https://example.com/start", prompt: "Summarize" },
      createContext({ httpClient, model }),
    );

    expect(getContentRequestCalls(httpClient)).toHaveLength(1);
    expect(model.generateText).not.toHaveBeenCalled();
    expect(output).toMatchObject({
      bytes: expect.any(Number),
      contentType: "text/plain",
      finalUrl: "https://example.com/start",
      redirects: [
        {
          from: "https://example.com/start",
          status: 302,
          to: "https://evil.example/final",
        },
      ],
      status: 302,
      statusText: "Found",
      truncated: false,
      url: "https://example.com/start",
    });
    expect(output.result).toBe(
      [
        "REDIRECT DETECTED: The URL redirects to a different host.",
        "",
        "Original URL: https://example.com/start",
        "Redirect URL: https://evil.example/final",
        "Status: 302 Found",
        "",
        "To complete your request, I need to fetch content from the redirected URL. Please use WebFetch again with these parameters:",
        '- url: "https://evil.example/final"',
        '- prompt: "Summarize"',
      ].join("\n"),
    );
  });

  it("uses status-code text for redirect outputs when response status text is empty", async () => {
    const httpClient = createHttpClient([
      response({
        headers: { location: "https://evil.example/final" },
        status: 302,
        statusText: "",
        url: "https://example.com/start",
      }),
    ]);
    const model = createTestModel("unused");

    const output = await webFetchHandler(
      { url: "https://example.com/start", prompt: "Summarize" },
      createContext({ httpClient, model }),
    );

    expect(output.statusText).toBe("Found");
    expect(output.result).toContain("Status: 302 Found");
  });

  it("returns credential redirects as a redacted model-readable tool result", async () => {
    const httpClient = createHttpClient([
      response({
        headers: { location: "https://user:secret@evil.example/final" },
        status: 302,
        statusText: "Found",
        url: "https://example.com/start",
      }),
    ]);
    const model = createTestModel("unused");

    const output = await webFetchHandler(
      { url: "https://example.com/start", prompt: "Summarize" },
      createContext({ httpClient, model }),
    );

    expect(getContentRequestCalls(httpClient)).toHaveLength(1);
    expect(model.generateText).not.toHaveBeenCalled();
    expect(output.result).toContain("REDIRECT DETECTED");
    expect(output.result).toContain('url: "https://evil.example/final"');
    expect(output.result).not.toContain("user:secret");
    expect(output.redirects).toEqual([
      {
        from: "https://example.com/start",
        status: 302,
        to: "https://evil.example/final",
      },
    ]);
  });

  it("returns private-host redirects as a model-readable tool result without fetching them", async () => {
    const httpClient = createHttpClient([
      response({
        headers: { location: "https://localhost/final" },
        status: 302,
        statusText: "Found",
        url: "https://example.com/start",
      }),
    ]);
    const model = createTestModel("unused");

    const output = await webFetchHandler(
      { url: "https://example.com/start", prompt: "Summarize" },
      createContext({ httpClient, model }),
    );

    expect(getContentRequestCalls(httpClient)).toHaveLength(1);
    expect(model.generateText).not.toHaveBeenCalled();
    expect(output.result).toContain("REDIRECT DETECTED");
    expect(output.result).toContain('url: "https://localhost/final"');
  });

  it("returns redirect responses with missing Location as HTTP errors", async () => {
    const httpClient = createHttpClient([
      response({
        body: "redirect error body",
        status: 302,
        statusText: "Found",
        url: "https://example.com/start",
      }),
    ]);
    const model = createTestModel("unused");

    const output = await webFetchHandler(
      { url: "https://example.com/start", prompt: "Summarize" },
      createContext({ httpClient, model }),
    );

    expect(getContentRequestCalls(httpClient)).toHaveLength(1);
    expect(model.generateText).not.toHaveBeenCalled();
    expect(output).toMatchObject({
      bytes: 0,
      contentType: "text/plain",
      finalUrl: "https://example.com/start",
      redirects: [],
      status: 302,
      statusText: "Found",
      truncated: false,
      url: "https://example.com/start",
    });
    expect(output.result).toContain("The server returned HTTP 302 Found.");
    expect(output.result).toContain("The response body was not retrieved.");
    expect(output.result).not.toContain("redirect error body");
  });

  it("does not treat non-followable 3xx responses as redirects", async () => {
    const httpClient = createHttpClient([
      response({
        body: "not modified body",
        headers: { location: "https://evil.example/final" },
        status: 304,
        statusText: "Not Modified",
        url: "https://example.com/start",
      }),
    ]);
    const model = createTestModel("unused");

    const output = await webFetchHandler(
      { url: "https://example.com/start", prompt: "Summarize" },
      createContext({ httpClient, model }),
    );

    expect(getContentRequestCalls(httpClient)).toHaveLength(1);
    expect(model.generateText).not.toHaveBeenCalled();
    expect(output).toMatchObject({
      bytes: 0,
      finalUrl: "https://example.com/start",
      redirects: [],
      status: 304,
      statusText: "Not Modified",
    });
    expect(output.result).toContain("The server returned HTTP 304 Not Modified.");
    expect(output.result).not.toContain("REDIRECT DETECTED");
    expect(output.result).not.toContain("not modified body");
  });

  it("returns non-2xx responses as HTTP errors without applying the lite model", async () => {
    const httpClient = createHttpClient([
      response({
        body: "not found body",
        status: 404,
        statusText: "Not Found",
        url: "https://example.com/missing",
      }),
    ]);
    const model = createTestModel("unused");

    const output = await webFetchHandler(
      { url: "https://example.com/missing", prompt: "Summarize" },
      createContext({ httpClient, model }),
    );

    expect(getContentRequestCalls(httpClient)).toHaveLength(1);
    expect(model.generateText).not.toHaveBeenCalled();
    expect(output).toMatchObject({
      bytes: 0,
      contentType: "text/plain",
      finalUrl: "https://example.com/missing",
      redirects: [],
      status: 404,
      statusText: "Not Found",
      truncated: false,
      url: "https://example.com/missing",
    });
    expect(output.result).toContain("The server returned HTTP 404 Not Found.");
    expect(output.result).toContain("The response body was not retrieved.");
    expect(output.result).not.toContain("not found body");
  });

  it("uses status-code text for HTTP error outputs when response status text is empty", async () => {
    const httpClient = createHttpClient([
      response({
        body: "not found body",
        status: 404,
        statusText: "",
        url: "https://example.com/missing",
      }),
    ]);
    const model = createTestModel("unused");

    const output = await webFetchHandler(
      { url: "https://example.com/missing", prompt: "Summarize" },
      createContext({ httpClient, model }),
    );

    expect(output.statusText).toBe("Not Found");
    expect(output.result).toContain("The server returned HTTP 404 Not Found.");
  });

  it("raises an egress-blocked error before generic HTTP error formatting", async () => {
    const httpClient = createHttpClient([
      response({
        body: "blocked body",
        headers: { "x-proxy-error": "blocked-by-allowlist" },
        status: 403,
        statusText: "Forbidden",
        url: "https://blocked.example/docs",
      }),
    ]);
    const model = createTestModel("unused");

    await expect(
      webFetchHandler(
        { url: "https://blocked.example/docs", prompt: "Summarize" },
        createContext({ httpClient, model }),
      ),
    ).rejects.toMatchObject({
      context: {
        domain: "blocked.example",
        error_type: "EGRESS_BLOCKED",
        webFetchCode: "webfetch_egress_blocked",
      },
    });
    expect(getContentRequestCalls(httpClient)).toHaveLength(1);
    expect(model.generateText).not.toHaveBeenCalled();
  });

  it("maps public egress policy blocks to WebFetch egress errors", async () => {
    const events: SessionEvent[] = [];
    const httpClient: HttpClientPort = {
      request: vi.fn<HttpClientPort["request"]>(async (request) => {
        throw createHttpClientError({
          code: "egress_blocked",
          message:
            "HTTP public egress blocked metadata.example because it resolved to 169.254.169.254",
          url: request.url,
        });
      }),
    };
    const model = createTestModel("unused");

    const request = webFetchHandler(
      { url: "https://metadata.example/latest", prompt: "Summarize" },
      createContext({
        emitEvent: async (event) => {
          events.push(event);
        },
        httpClient,
        model,
      }),
    );

    await expect(request).rejects.toThrow(
      "HTTP public egress blocked metadata.example because it resolved to a non-public address",
    );
    await expect(request).rejects.toMatchObject({
      context: {
        domain: "metadata.example",
        error_type: "EGRESS_BLOCKED",
        webFetchCode: "webfetch_egress_blocked",
      },
    });
    expect(events.map((event) => event.payload as Record<string, unknown>)[1]).toMatchObject({
      error:
        "HTTP public egress blocked metadata.example because it resolved to a non-public address",
      status: "error",
    });
    expect(model.generateText).not.toHaveBeenCalled();
  });

  it("rejects local hostnames before any network request", async () => {
    const httpClient = createHttpClient([]);
    const model = createTestModel("unused");

    await expect(
      webFetchHandler(
        { url: "https://localhost/status", prompt: "Summarize" },
        createContext({ httpClient, model }),
      ),
    ).rejects.toThrow("public hostname");
    expect(httpClient.request).not.toHaveBeenCalled();
  });

  it("rejects URLs longer than the WebFetch runtime limit", async () => {
    const httpClient = createHttpClient([]);
    const model = createTestModel("unused");
    const longUrl = `https://example.com/${"a".repeat(2001)}`;

    await expect(
      webFetchHandler({ url: longUrl, prompt: "Summarize" }, createContext({ httpClient, model })),
    ).rejects.toThrow("URL is too long");
    expect(httpClient.request).not.toHaveBeenCalled();
  });

  it("skips external domain safety preflight and fetches the target URL directly", async () => {
    const httpClient = createHttpClient([
      response({
        body: "target content wins over domain safety service",
        contentType: "text/plain",
        url: "https://blocked.example/docs",
      }),
    ]);
    const model = createTestModel("target answer");

    const output = await webFetchHandler(
      { url: "https://blocked.example/docs", prompt: "Summarize" },
      createContext({ httpClient, model }),
    );

    expect(output).toMatchObject({
      finalUrl: "https://blocked.example/docs",
      result: "target answer",
    });
    expect(httpClient.request).toHaveBeenCalledTimes(1);
    expect(getContentRequestCalls(httpClient)).toHaveLength(1);
    expect(getContentRequestCalls(httpClient)[0]?.[0]).toMatchObject({
      method: "GET",
      url: "https://blocked.example/docs",
    });
  });

  it("does not fail when the old domain safety service is unreachable", async () => {
    const httpClient: HttpClientPort = {
      request: vi.fn<HttpClientPort["request"]>(async (request) => {
        if (request.url !== "https://example.com/docs") {
          throw new Error(`unexpected WebFetch request: ${request.url}`);
        }
        return response({
          body: "reachable target",
          contentType: "text/plain",
          url: request.url,
        });
      }),
    };
    const model = createTestModel("reachable answer");

    const output = await webFetchHandler(
      { url: "https://example.com/docs", prompt: "Summarize" },
      createContext({ httpClient, model }),
    );

    expect(output.result).toBe("reachable answer");
    expect(httpClient.request).toHaveBeenCalledTimes(1);
    expect(getContentRequestCalls(httpClient)).toHaveLength(1);
  });
});

function createContext(options: {
  emitEvent?: (event: SessionEvent) => Promise<void>;
  httpClient: HttpClientPort;
  model: Model;
}): ToolExecutionContext {
  const modelSelection = {
    modelId: createModelId("test-model"),
    providerId: createModelProviderId("test"),
  };
  return {
    abortSignal: new AbortController().signal,
    emitEvent: options.emitEvent,
    httpClientPort: options.httpClient,
    model: options.model,
    modelSelection,
    sessionId: createSessionId("webfetch"),
    toolCallId: "webfetch-call",
    traceId: "trace-webfetch" as never,
    turnId: createTurnId("webfetch"),
    workingDirectory: "/tmp/zcode-webfetch-tool",
    workspaceRoot: "/tmp/zcode-webfetch-tool",
  };
}

function createHttpClient(responses: HttpClientResponse[]): HttpClientPort {
  return {
    request: vi.fn<HttpClientPort["request"]>(async () => {
      const next = responses.shift();
      if (!next) {
        throw new Error("No fake WebFetch response was configured");
      }
      return next;
    }),
  };
}

type HttpClientRequestCall = Parameters<HttpClientPort["request"]>;

function getContentRequestCalls(httpClient: HttpClientPort): HttpClientRequestCall[] {
  return vi.mocked(httpClient.request).mock.calls;
}

function createTestModel(text: string): Model {
  const model: Model = {
    providerId: createModelProviderId("test"),
    modelId: createModelId("test-model"),
    properties: {
      contextWindow: 200_000,
      ...createTestModelFormatProperties(),
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    },
    optionSpecs: {
      reasoningLevel: { values: ["low", "high"] },
      maxOutputTokens: { max: 32_000 },
    },
    options: { maxOutputTokens: 32_000, reasoningLevel: "high" },
    bind() {
      return this;
    },
    generateText: vi.fn<Model["generateText"]>(async () => ({
      finishReason: "stop",
      model: { providerId: model.providerId, modelId: model.modelId },
      text,
      usage: {},
    })),
    async *streamText() {
      yield { type: "start" };
      yield { finishReason: "stop", type: "finish", usage: {} };
    },
  };
  return model;
}

function response(options: {
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
  status?: number;
  statusText?: string;
  url: string;
}): HttpClientResponse {
  const body = new TextEncoder().encode(options.body ?? "");
  const headers = {
    "content-type": options.contentType ?? "text/html; charset=utf-8",
    ...options.headers,
  };
  return {
    body,
    bytes: body.byteLength,
    durationMs: 5,
    headers,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    url: options.url,
  };
}
