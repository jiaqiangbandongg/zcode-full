import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createProviderBusinessErrorFetch } from "../src/model/model-execution.js";
import { createGenerateTextOptions } from "../src/model/runner-options.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";
import { createTestModelProperties } from "./test-model-format.js";

const OUTPUT_TOKEN_CONTINUE_PROMPT =
  "Output token limit hit. Resume directly — no apology, no recap of what you were doing. Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.";

describe("Anthropic Continue request body", () => {
  // 恢复 v0.16.6 的 wire 验收：通过真实 SDK 序列化检查相邻 user 合并后的准确文案和次数。
  it.each([1, 3])(
    "keeps %i exact Continue prompts when Anthropic merges adjacent users",
    async (count) => {
      let capturedBody: Record<string, unknown> | undefined;
      const provider = createAnthropic({
        apiKey: "fake-key",
        baseURL: "https://api.example.test",
        fetch: async (_input, init) => {
          if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
          capturedBody = JSON.parse(init.body) as Record<string, unknown>;
          return new Response(
            JSON.stringify({ error: { message: "wire capture", type: "test" } }),
            {
              headers: { "content-type": "application/json" },
              status: 400,
            },
          );
        },
      });
      const options = createGenerateTextOptions({
        includeModelIO: false,
        request: {
          messages: [
            { role: "user", content: "original user request" },
            ...Array.from({ length: count }, () => ({
              role: "user" as const,
              content: OUTPUT_TOKEN_CONTINUE_PROMPT,
            })),
          ],
        },
        resolved: {
          properties: createTestModelProperties(),
          model: provider("anthropic-model"),
          providerKind: "anthropic",
          providerId: "wire-provider",
          modelId: "anthropic-model",
        } as ResolvedAiSdkModel,
        statusContext: {
          providerId: "wire-provider",
          modelId: "anthropic-model",
          providerKind: "anthropic",
          requestId: "req_output_continue_wire",
          sessionId: "sess_output_continue_wire",
          traceId: "trace_output_continue_wire",
        } as never,
      });

      await expect(generateText(options)).rejects.toBeDefined();

      expect(capturedBody?.messages).toEqual([expect.objectContaining({ role: "user" })]);
      const bodyText = JSON.stringify(capturedBody);
      expect(bodyText).toContain("original user request");
      expect(bodyText.split(OUTPUT_TOKEN_CONTINUE_PROMPT)).toHaveLength(count + 1);
      expect(bodyText).not.toContain("<system-reminder>");
    },
  );
});

describe("provider business request body", () => {
  it.each([
    {
      body: JSON.stringify({ model: "reasoning-model", max_tokens: 12_345 }),
      name: "a provider name that used to trigger the implicit rewrite",
    },
    {
      body: JSON.stringify({ model: "reasoning-model", temperature: 0.7 }),
      name: "a JSON body without max_tokens",
    },
    { body: "not-json", name: "a non-JSON body" },
  ])("preserves $name for Snowflake Cortex", async ({ body }) => {
    let capturedBody: BodyInit | null | undefined;
    const fetch = createProviderBusinessErrorFetch({
      fetch: async (_input, init) => {
        capturedBody = init?.body;
        return new Response("{}", {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      },
      providerId: "snowflake-cortex",
      providerKind: "openai-compatible",
    });

    await fetch("https://example.test/v1/chat/completions", { body, method: "POST" });

    expect(capturedBody).toBe(body);
  });
});
