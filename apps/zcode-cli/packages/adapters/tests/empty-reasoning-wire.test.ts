import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import type { ModelInputMessage } from "@zcode/contracts";
import { createGenerateTextOptions } from "../src/model/runner-options.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";
import { createTestModelProperties } from "./test-model-format.js";

describe("empty reasoning history wire shape", () => {
  it("omits an exact-empty metadata-free reasoning stub from Anthropic history", async () => {
    const capturedBody = await captureAnthropicBody({
      messages: [
        { role: "user", content: "start" },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "" },
            { type: "text", text: "done" },
          ],
        },
        { role: "user", content: "finish" },
      ],
      modelId: "claude-sonnet-4",
      providerId: "anthropic",
    });
    const messages = capturedBody.messages as Record<string, unknown>[];

    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    });
  });

  it("does not synthesize a DeepSeek empty thinking placeholder before a tool call", async () => {
    const toolCallId = "call_deepseek_empty_thinking";
    const capturedBody = await captureAnthropicBody({
      messages: [
        { role: "user", content: "start" },
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "" }],
          toolCalls: [{ id: toolCallId, name: "Read", input: { file_path: "README.md" } }],
        },
        {
          role: "tool",
          content: "tool result",
          toolCallId,
          toolName: "Read",
        },
        { role: "user", content: "finish" },
      ],
      modelId: "deepseek-v4-pro",
      providerId: "deepseek",
    });
    const messages = capturedBody.messages as Array<{ content?: unknown }>;

    expect(messages[1]?.content).toEqual([
      {
        type: "tool_use",
        id: toolCallId,
        name: "Read",
        input: { file_path: "README.md" },
      },
    ]);
  });
});

async function captureAnthropicBody(input: {
  messages: ModelInputMessage[];
  modelId: string;
  providerId: string;
}): Promise<Record<string, unknown>> {
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createAnthropic({
    apiKey: "fake-ak",
    baseURL: "https://api.anthropic.example.test/v1",
    fetch: async (_request, init) => {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON request body");
      }
      capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          content: [{ text: "ok", type: "text" }],
          id: "msg_empty_reasoning_history",
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
      messages: input.messages,
      providerOptions: {
        anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
      },
    },
    resolved: {
      properties: createTestModelProperties(),
      baseURL: "https://api.anthropic.example.test/v1",
      model: provider(input.modelId),
      providerKind: "anthropic",
      providerId: input.providerId,
      modelId: input.modelId,
    } as ResolvedAiSdkModel,
    statusContext: {
      providerId: input.providerId,
      modelId: input.modelId,
      providerKind: "anthropic",
      requestId: `req_${input.providerId}_empty_reasoning`,
      sessionId: `sess_${input.providerId}_empty_reasoning`,
      traceId: `trace_${input.providerId}_empty_reasoning`,
    } as never,
  });

  await generateText(options);
  if (!capturedBody) {
    throw new Error("Anthropic reasoning history request body was not captured");
  }
  return capturedBody;
}
