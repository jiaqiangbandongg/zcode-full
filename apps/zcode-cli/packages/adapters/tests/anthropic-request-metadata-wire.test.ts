import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, streamText } from "ai";
import { describe, expect, it } from "vitest";
import { createGenerateTextOptions, createStreamTextOptions } from "../src/model/runner-options.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";
import { createTestModelProperties } from "./test-model-format.js";

const metadataUserId = JSON.stringify({
  device_id: "7f1431f0-53e8-41c1-9cf9-22d11aa51d6a",
  account_uuid: "",
  session_id: "2d480878-38af-4bae-a54f-096e2fb0f4d7",
});

describe("Anthropic request metadata wire shape", () => {
  it("sends metadata.user_id in generate requests", async () => {
    const capture = createRequestCapture();
    const options = createOptions(capture.fetch, "generate");

    await expect(generateText(options)).rejects.toBeDefined();

    expect(capture.body()).toMatchObject({
      metadata: {
        user_id: metadataUserId,
      },
    });
  });

  it("sends metadata.user_id in stream requests", async () => {
    const capture = createRequestCapture();
    const result = streamText(createOptions(capture.fetch, "stream"));

    await drain(result.fullStream);

    expect(capture.body()).toMatchObject({
      metadata: {
        user_id: metadataUserId,
      },
    });
  });
});

function createOptions(
  fetch: typeof globalThis.fetch,
  kind: "generate" | "stream",
): ReturnType<typeof createGenerateTextOptions> | ReturnType<typeof createStreamTextOptions> {
  const provider = createAnthropic({
    apiKey: "fake-key",
    baseURL: "https://api.example.test",
    fetch,
  });
  const input = {
    anthropicMetadataUserId: metadataUserId,
    includeModelIO: false,
    request: {
      messages: [{ content: "hi", role: "user" as const }],
      providerOptions: {
        anthropic: {
          effort: "high",
          metadata: { userId: "stale-static-user-id" },
        },
      },
    },
    resolved: {
      properties: createTestModelProperties(),
      model: provider("claude-test"),
      providerKind: "anthropic" as const,
      providerId: "anthropic",
      modelId: "claude-test",
    } as ResolvedAiSdkModel,
    statusContext: {
      providerId: "anthropic",
      modelId: "claude-test",
      providerKind: "anthropic",
      requestId: `req_anthropic_metadata_${kind}`,
      sessionId: "sess_2d480878-38af-4bae-a54f-096e2fb0f4d7",
      traceId: `trace_anthropic_metadata_${kind}`,
    } as never,
  };

  return kind === "generate" ? createGenerateTextOptions(input) : createStreamTextOptions(input);
}

function createRequestCapture(): {
  body: () => Record<string, unknown>;
  fetch: typeof globalThis.fetch;
} {
  let capturedBody: Record<string, unknown> | undefined;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected a JSON request body");
    }
    capturedBody = JSON.parse(init.body) as Record<string, unknown>;
    return new Response(JSON.stringify({ error: { message: "wire capture", type: "test" } }), {
      headers: { "content-type": "application/json" },
      status: 400,
    });
  };

  return {
    body() {
      if (!capturedBody) {
        throw new Error("Expected the provider request body to be captured");
      }
      return capturedBody;
    },
    fetch,
  };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Drain the provider stream until its expected wire-capture error.
  }
}
