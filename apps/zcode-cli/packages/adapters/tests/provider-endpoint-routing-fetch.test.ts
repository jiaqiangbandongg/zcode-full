import { describe, expect, it, vi } from "vitest";
import type { ProviderEndpointRoutingPort } from "@zcode/contracts";
import { createProviderEndpointRoutingFetch } from "../src/model/provider-endpoint-routing-fetch.js";
import { createProviderBusinessErrorFetch } from "../src/model/model-execution.js";

const SOURCE_ZAI = "https://api.z.ai/api/anthropic/v1/messages";
const TARGET = "https://zcode.z.ai/api/v1/proxy/anthropic/v1/messages";

describe("provider endpoint routing fetch", () => {
  it("preserves request semantics and the streaming response while recalculating Host", async () => {
    const controller = new AbortController();
    const routingPort = {
      resolve: vi.fn<ProviderEndpointRoutingPort["resolve"]>(async () => ({
        routed: true,
        url: `${TARGET}?original=query`,
      })),
    };
    let captured: Request | undefined;
    const sseResponse = new Response("data: first\n\ndata: second\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    const fetch = createProviderEndpointRoutingFetch({
      fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
        captured = new Request(input, init);
        return sseResponse;
      }),
      routingPort,
      apiKeyId: "real-key-id",
    });
    const input = new Request(`${SOURCE_ZAI}?original=query`, {
      body: JSON.stringify({ stream: true }),
      headers: {
        Authorization: "Bearer secret",
        Host: "api.z.ai",
        "x-api-key": "provider-key",
        "X-ZCode-Trace-Id": "trace-1",
      },
      method: "POST",
      signal: controller.signal,
    });

    const response = await fetch(input);

    expect(response).toBe(sseResponse);
    expect(routingPort.resolve).toHaveBeenCalledWith(`${SOURCE_ZAI}?original=query`, {
      apiKeyId: "real-key-id",
      signal: input.signal,
      trace: { traceId: "trace-1" },
    });
    expect(captured?.url).toBe(`${TARGET}?original=query`);
    expect(captured?.method).toBe("POST");
    expect(captured?.headers.get("authorization")).toBe("Bearer secret");
    expect(captured?.headers.get("x-api-key")).toBe("provider-key");
    expect(captured?.headers.has("host")).toBe(false);
    await expect(captured?.text()).resolves.toBe(JSON.stringify({ stream: true }));
    controller.abort();
    expect(captured?.signal.aborted).toBe(true);
    await expect(response.text()).resolves.toBe("data: first\n\ndata: second\n\n");
  });

  it("does not derive x-api-key from Authorization", async () => {
    const routingPort = {
      resolve: vi.fn<ProviderEndpointRoutingPort["resolve"]>(async (url) => ({
        routed: false,
        url,
      })),
    };
    const fetch = createProviderEndpointRoutingFetch({
      fetch: vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 })),
      routingPort,
    });

    await fetch(SOURCE_ZAI, {
      headers: {
        Authorization: "Bearer provider-key",
        "X-ZCode-Trace-Id": "trace-authorization-only",
      },
    });

    expect(routingPort.resolve).toHaveBeenCalledWith(SOURCE_ZAI, {
      signal: undefined,
      trace: { traceId: "trace-authorization-only" },
    });
  });

  it("does not forward manual x-api-key from either Request or RequestInit", async () => {
    const routingPort = {
      resolve: vi.fn<ProviderEndpointRoutingPort["resolve"]>(async (url) => ({
        routed: false,
        url,
      })),
    };
    const fetch = createProviderEndpointRoutingFetch({
      fetch: vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 })),
      routingPort,
    });
    const input = new Request(SOURCE_ZAI, {
      headers: { "x-api-key": "request-key" },
    });

    await fetch(input, {
      headers: { "X-API-Key": "init-key" },
    });

    expect(routingPort.resolve).toHaveBeenCalledWith(SOURCE_ZAI, {
      signal: input.signal,
      trace: undefined,
    });
  });

  it("rewrites before proxy and no-proxy selection", async () => {
    let capturedUrl: string | undefined;
    const fetch = createProviderBusinessErrorFetch({
      endpointRoutingPort: {
        async resolve() {
          return {
            routed: true,
            url: "https://direct.example.test/v1/messages",
          };
        },
      },
      fetch: async (input) => {
        capturedUrl = input instanceof Request ? input.url : String(input);
        return new Response(null, { status: 204 });
      },
      httpProxy: "http://127.0.0.1:1",
      noProxy: "direct.example.test",
      providerId: "zai",
      providerKind: "anthropic",
    });

    await expect(fetch(SOURCE_ZAI)).resolves.toMatchObject({ status: 204 });
    expect(capturedUrl).toBe("https://direct.example.test/v1/messages");
  });
});
