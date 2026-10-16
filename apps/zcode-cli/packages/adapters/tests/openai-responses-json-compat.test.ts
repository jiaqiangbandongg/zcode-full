import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
  createOpenAIResponsesJsonCompatFetch,
  normalizeOpenAIResponsesJson,
} from "../src/model/openai-responses-json-compat.js";
import {
  TestAiSdkModelAdapter as AiSdkModelAdapter,
  TestProviderConfigFixture,
} from "./test-provider-config.js";
import { executeAdapterGenerateText } from "./test-adapter-model.js";

const OPENAI_MESSAGE_UUID_PATTERN =
  /^msg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe("OpenAI Responses JSON compatibility", () => {
  it("fills only missing message ids and output-text annotations", () => {
    const untouchedOutput = { id: "reasoning-1", type: "reasoning", summary: [] };
    const normalized = normalizeOpenAIResponsesJson({
      id: "resp_compact",
      output: [
        untouchedOutput,
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "summary" },
            { type: "refusal", refusal: "no" },
          ],
        },
      ],
      vendor_field: "preserved",
    });

    expect(normalized).toEqual({
      id: "resp_compact",
      output: [
        untouchedOutput,
        {
          id: expect.stringMatching(OPENAI_MESSAGE_UUID_PATTERN),
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "summary", annotations: [] },
            { type: "refusal", refusal: "no" },
          ],
        },
      ],
      vendor_field: "preserved",
    });
    expect(normalized?.output?.[0]).toBe(untouchedOutput);
  });

  it("leaves valid responses and unknown output items unchanged", () => {
    const validBody = {
      id: "resp_valid",
      output: [
        {
          id: "msg_valid",
          type: "message",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        },
      ],
    };
    expect(normalizeOpenAIResponsesJson(validBody)).toBeUndefined();
    expect(
      normalizeOpenAIResponsesJson({
        id: "resp_unknown",
        output: [{ type: "custom_output", value: "untouched" }],
      }),
    ).toBeUndefined();
  });

  it("returns the original response for valid JSON, SSE, errors, and invalid JSON", async () => {
    const validResponse = jsonResponse({
      id: "resp_valid",
      output: [
        {
          id: "msg_valid",
          type: "message",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        },
      ],
    });
    const eventStreamResponse = new Response("data: {}\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    const errorResponse = jsonResponse(missingFieldsBody(), { status: 400 });
    const invalidJsonResponse = new Response("not-json", {
      headers: { "content-type": "application/json" },
    });

    for (const response of [
      validResponse,
      eventStreamResponse,
      errorResponse,
      invalidJsonResponse,
    ]) {
      const compatFetch = createOpenAIResponsesJsonCompatFetch(async () => response);
      await expect(compatFetch("https://example.test/responses")).resolves.toBe(response);
    }
  });

  it("preserves response metadata and removes stale representation headers", async () => {
    const response = jsonResponse(missingFieldsBody(), {
      headers: {
        "content-encoding": "gzip",
        "content-length": "123",
        "x-provider-request-id": "req-1",
      },
      status: 201,
      statusText: "Created",
    });
    const compatFetch = createOpenAIResponsesJsonCompatFetch(async () => response);

    const normalized = await compatFetch("https://example.test/responses");

    expect(normalized).not.toBe(response);
    expect(normalized.status).toBe(201);
    expect(normalized.statusText).toBe("Created");
    expect(normalized.headers.get("x-provider-request-id")).toBe("req-1");
    expect(normalized.headers.get("content-length")).toBeNull();
    expect(normalized.headers.get("content-encoding")).toBeNull();
    await expect(normalized.json()).resolves.toMatchObject({
      output: [
        {
          id: expect.stringMatching(OPENAI_MESSAGE_UUID_PATTERN),
          content: [{ annotations: [] }],
        },
      ],
    });
  });

  it("accepts the missing message fields seen in non-stream compact responses", async () => {
    const requests: Array<{ method?: string; url?: string }> = [];
    const server = http.createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "resp_compact",
          created_at: 1,
          model: "gpt-5.5-e2e",
          object: "response",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "RESPONSES_COMPACT_SUMMARY_MARKER",
                },
              ],
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
        }),
      );
    });

    try {
      const baseURL = await listenServer(server);
      const adapter = new AiSdkModelAdapter({
        registry: new TestProviderConfigFixture({
          env: {},
          providers: {
            responses: {
              apiKey: "sk-e2e-fake",
              baseURL,
              kind: "openai",
            },
          },
        }),
        retry: { maxAttempts: 1 },
      });

      const result = await executeAdapterGenerateText(adapter, {
        messages: [{ role: "user", content: "compact" }],
        providerId: "responses" as never,
        modelId: "gpt-5.5-e2e" as never,
      });

      expect(result.text).toBe("RESPONSES_COMPACT_SUMMARY_MARKER");
      expect(requests).toEqual([{ method: "POST", url: "/responses" }]);
    } finally {
      await closeServer(server);
    }
  });

  it("keeps OpenAI-compatible models on Chat Completions", async () => {
    const requests: Array<{ method?: string; url?: string }> = [];
    const responseBody = {
      id: "chatcmpl_compat",
      model: "compat-e2e",
      object: "chat.completion",
      created: 1,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "CHAT_COMPLETIONS_MARKER",
          },
        },
      ],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
      },
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "must remain untouched" }],
        },
      ],
    };
    const server = http.createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responseBody));
    });

    try {
      const baseURL = await listenServer(server);
      const registry = new TestProviderConfigFixture({
        env: {},
        providers: {
          compatible: {
            apiKey: "sk-e2e-fake",
            baseURL,
            kind: "openai-compatible",
          },
        },
      });

      const result = await generateText({
        model: registry.resolve("compatible/compat-e2e").model,
        prompt: "chat",
      });

      expect(result.text).toBe("CHAT_COMPLETIONS_MARKER");
      expect(result.response.body).toEqual(responseBody);
      expect(requests).toEqual([{ method: "POST", url: "/chat/completions" }]);
    } finally {
      await closeServer(server);
    }
  });
});

function missingFieldsBody(): Record<string, unknown> {
  return {
    id: "resp_compact",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "summary" }],
      },
    ],
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

async function listenServer(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
