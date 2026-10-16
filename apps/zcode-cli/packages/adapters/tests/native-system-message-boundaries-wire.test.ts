import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createGenerateTextOptions } from "../src/model/runner-options.js";
import type { AiSdkProviderKind } from "../src/model/model-execution.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";
import { createTestModelProperties } from "./test-model-format.js";

const SYSTEM_CONTENTS = ["cli prefix", "\nstable context", "\n\ndynamic context"] as const;

describe("native provider system message boundaries", () => {
  it("preserves each Anthropic system block exactly", async () => {
    const capture = createRequestCapture();
    const provider = createAnthropic({
      apiKey: "fake-key",
      baseURL: "https://api.example.test",
      fetch: capture.fetch,
    });

    await captureRejectedRequest({
      model: provider("claude-opus-4-8"),
      modelId: "claude-opus-4-8",
      providerKind: "anthropic",
      systemContents: SYSTEM_CONTENTS,
    });

    const system = capture.body().system as Array<{ text: string; type: string }>;
    expect(system).toHaveLength(SYSTEM_CONTENTS.length);
    expect(system.map((block) => block.text)).toEqual(SYSTEM_CONTENTS);
  });

  it("preserves each OpenAI Responses developer message exactly", async () => {
    const capture = createRequestCapture();
    const provider = createOpenAI({
      apiKey: "fake-key",
      baseURL: "https://api.example.test/v1",
      fetch: capture.fetch,
    });

    await captureRejectedRequest({
      model: provider.responses("gpt-5.2"),
      modelId: "gpt-5.2",
      providerKind: "openai",
      systemContents: SYSTEM_CONTENTS,
    });

    expect((capture.body().input as unknown[]).slice(0, SYSTEM_CONTENTS.length)).toEqual(
      SYSTEM_CONTENTS.map((content) => ({ content, role: "developer" })),
    );
  });
});

async function captureRejectedRequest(input: {
  model: ResolvedAiSdkModel["model"];
  modelId: string;
  providerKind: AiSdkProviderKind;
  systemContents: readonly string[];
}): Promise<void> {
  const options = createGenerateTextOptions({
    includeModelIO: false,
    request: {
      messages: [
        ...input.systemContents.map((content) => ({ content, role: "system" as const })),
        { content: "question", role: "user" },
      ],
      ...(input.providerKind === "openai" ? { providerOptions: { openai: { store: false } } } : {}),
    },
    resolved: {
      properties: createTestModelProperties(),
      model: input.model,
      providerKind: input.providerKind,
      providerId: "wire-provider",
      modelId: input.modelId,
    } as ResolvedAiSdkModel,
    statusContext: {
      providerId: "wire-provider",
      modelId: input.modelId,
      providerKind: input.providerKind,
      requestId: "req_system_boundaries_wire",
      sessionId: "sess_system_boundaries_wire",
      traceId: "trace_system_boundaries_wire",
    } as never,
  });

  await expect(generateText(options)).rejects.toBeDefined();
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
