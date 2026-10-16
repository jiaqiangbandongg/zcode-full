import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createGenerateTextOptions } from "../src/model/runner-options.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";
import { createTestModelProperties } from "./test-model-format.js";

describe("Anthropic effort wire shape", () => {
  it.each(["low", "high", "max"] as const)(
    "sends Kimi K3 %s effort through output_config without K2 thinking",
    async (effort) => {
      const capturedBody = await captureAnthropicEffortRequest({
        effort,
        modelId: "kimi-k3",
        providerId: "moonshot-kimi",
      });

      expect(capturedBody).toMatchObject({ output_config: { effort } });
      expect(capturedBody).not.toHaveProperty("thinking");
    },
  );

  it.each(["low", "high", "max"] as const)(
    "maps canonical %s config through to adaptive wire fields",
    async (effort) => {
      const modelId = "opaque-model";
      const canonicalOptions = { effort, thinking: { type: "adaptive" } };
      const capturedBody = await captureAnthropicEffortRequest({
        effort,
        modelId,
        providerId: "openrouter-anthropic",
        providerOptions: canonicalOptions,
      });

      expect(capturedBody).toMatchObject({
        model: modelId,
        output_config: { effort },
        thinking: { type: "adaptive" },
      });
      expect(capturedBody).not.toHaveProperty("thinking.budget_tokens");
      expect(capturedBody).not.toHaveProperty("reasoning_effort");
    },
  );

  it("sends GPT xhigh effort through Anthropic output_config", async () => {
    const capturedBody = await captureAnthropicEffortRequest({
      effort: "xhigh",
      modelId: "gpt-5.6-sol",
      providerId: "custom-anthropic-gpt",
    });

    expect(capturedBody).toMatchObject({ output_config: { effort: "xhigh" } });
    expect(capturedBody).not.toHaveProperty("reasoning_effort");
  });
});

async function captureAnthropicEffortRequest(input: {
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  modelId: string;
  providerId: string;
  providerOptions?: Record<string, unknown>;
}): Promise<Record<string, unknown> | undefined> {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createAnthropic({
    apiKey: "fake-ak",
    baseURL: "https://example.com/v1",
    fetch: async (_request, init) => {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON request body");
      }
      capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          content: [{ text: "ok", type: "text" }],
          id: "msg_anthropic_effort",
          model: input.modelId,
          role: "assistant",
          stop_reason: "end_turn",
          stop_sequence: null,
          type: "message",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const options = createGenerateTextOptions({
    includeModelIO: false,
    request: {
      messages: [{ content: "hi", role: "user" }],
      providerOptions: { anthropic: input.providerOptions ?? { effort: input.effort } },
    },
    resolved: {
      properties: createTestModelProperties(),
      baseURL: "https://example.com/v1",
      model: provider(input.modelId),
      providerKind: "anthropic",
      providerId: input.providerId,
      modelId: input.modelId,
    } as ResolvedAiSdkModel,
    statusContext: {
      providerId: input.providerId,
      modelId: input.modelId,
      providerKind: "anthropic",
      requestId: `req_${input.providerId}_${input.effort}`,
      sessionId: `sess_${input.providerId}_${input.effort}`,
      traceId: `trace_${input.providerId}_${input.effort}`,
    } as never,
  });

  await generateText(options);
  return capturedBody;
}
