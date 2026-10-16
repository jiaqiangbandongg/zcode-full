import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import type { ModelInputMessage, ModelToolContract } from "@zcode/contracts";
import { createGenerateTextOptions } from "../src/model/runner-options.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";
import { createTestModelProperties } from "./test-model-format.js";

describe("OpenAI-compatible wire shape", () => {
  it("keeps generic OpenAI-compatible tool refs unchanged", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatible({
      apiKey: "fake-ak",
      baseURL: "https://api.kimi.com/coding/v1",
      name: "Kimi K3 tool schema",
      fetch: async (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new Error("Expected a JSON request body");
        }
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: { content: "ok", role: "assistant" },
              },
            ],
            id: "chatcmpl-kimi-k3-tools",
            model: "kimi-k3",
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const manageFunctionsTool: ModelToolContract = {
      capability: "cloud_functions",
      description: "Manage cloud functions",
      inputSchema: {
        type: "object",
        properties: {
          func: {
            type: "object",
            properties: {
              vpc: {
                type: "object",
                properties: { vpcId: { type: "string" } },
                required: ["vpcId"],
              },
            },
          },
          vpc: { $ref: "#/properties/func/properties/vpc" },
        },
      },
      name: "manageFunctions",
      outputSchema: { type: "object" },
      readOnly: false,
    };
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ role: "user", content: "hi" }],
        tools: [manageFunctionsTool],
      },
      resolved: {
        properties: createTestModelProperties(),
        baseURL: "https://api.kimi.com/coding/v1",
        model: provider("kimi-k3"),
        providerKind: "openai-compatible",
        providerId: "moonshot-kimi",
        modelId: "kimi-k3",
      } as ResolvedAiSdkModel,
      statusContext: {
        providerId: "moonshot-kimi",
        modelId: "kimi-k3",
        providerKind: "openai-compatible",
        requestId: "req_kimi_k3_tool_schema",
        sessionId: "sess_kimi_k3_tool_schema",
        traceId: "trace_kimi_k3_tool_schema",
      } as never,
    });

    await generateText(options);

    expect(capturedBody).toMatchObject({
      tools: [
        {
          function: {
            name: "manageFunctions",
            parameters: {
              properties: {
                vpc: { $ref: "#/properties/func/properties/vpc" },
              },
            },
          },
          type: "function",
        },
      ],
    });
    expect(manageFunctionsTool.inputSchema).toHaveProperty(
      "properties.vpc.$ref",
      "#/properties/func/properties/vpc",
    );
  });

  it("does not inject DeepSeek reasoning_content into history", async () => {
    const toolCallId = "call_deepseek_empty_reasoning_wire";
    const capturedBody = await captureDeepSeekReasoningHistoryBody([
      { role: "user", content: "start" },
      { role: "assistant", content: "plain answer" },
      { role: "user", content: "use a tool" },
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
    ]);
    const messages = capturedBody.messages as Record<string, unknown>[];

    expect(messages[1]).toEqual({ role: "assistant", content: "plain answer" });
    expect(messages[3]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: toolCallId, type: "function" }],
    });
    expect(messages[3]).not.toHaveProperty("reasoning_content");
  });

  it("serializes a sole empty DeepSeek reasoning block as empty assistant content", async () => {
    const capturedBody = await captureDeepSeekReasoningHistoryBody([
      { role: "user", content: "start" },
      { role: "assistant", content: [{ type: "reasoning", text: "" }] },
      { role: "user", content: "finish" },
    ]);
    const messages = capturedBody.messages as Record<string, unknown>[];

    expect(messages[1]).toEqual({ role: "assistant", content: "" });
  });
});

async function captureDeepSeekReasoningHistoryBody(
  messages: ModelInputMessage[],
): Promise<Record<string, unknown>> {
  const providerName = "DeepSeek reasoning history E2E";
  let capturedBody: Record<string, unknown> | undefined;
  const provider = createOpenAICompatible({
    apiKey: "fake-ak",
    baseURL: "https://api.deepseek.example.test/v1",
    name: providerName,
    fetch: async (_input, init) => {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON request body");
      }
      capturedBody = JSON.parse(init.body) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "ok", role: "assistant" },
            },
          ],
          id: "chatcmpl-deepseek-reasoning-history",
          model: "deepseek-v4-pro",
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const options = createGenerateTextOptions({
    includeModelIO: false,
    request: { messages },
    resolved: {
      properties: createTestModelProperties(),
      baseURL: "https://api.deepseek.example.test/v1",
      model: provider("deepseek-v4-pro"),
      providerKind: "openai-compatible",
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
    } as ResolvedAiSdkModel,
    statusContext: {
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      providerKind: "openai-compatible",
      requestId: "req_deepseek_reasoning_history_wire",
      sessionId: "sess_deepseek_reasoning_history_wire",
      traceId: "trace_deepseek_reasoning_history_wire",
    } as never,
  });

  await generateText(options);
  if (!capturedBody) {
    throw new Error("DeepSeek reasoning history request body was not captured");
  }
  return capturedBody;
}
