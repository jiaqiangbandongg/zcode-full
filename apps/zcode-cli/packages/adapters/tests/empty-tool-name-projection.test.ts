import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { ModelErrorCode } from "@zcode/contracts";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { AiSdkModelAdapterError } from "../src/model/errors.js";
import { toAiSdkMessages } from "../src/model/index.js";

const TOOL_CALL_ID = "call_empty_name";
const MODEL_CONTENT = "<tool_use_error>Error: No such tool available: </tool_use_error>";

describe("empty tool name provider projection", () => {
  it("gives explicit apiFormat precedence over provider kind", () => {
    const messages = emptyToolMessages();

    const anthropic = toAiSdkMessages(messages, {
      apiFormat: "anthropic-messages",
      providerKind: "openai-compatible",
    });
    const chatCompletions = toAiSdkMessages(messages, {
      apiFormat: "openai-chat-completions",
      providerKind: "anthropic",
    });

    expect((anthropic[0] as any).content[0].toolName).toBe("");
    expect((anthropic[1] as any).content[0].toolName).toBe("");
    expect((chatCompletions[0] as any).content[0].toolName).toBe("empty_tool_name");
    expect((chatCompletions[1] as any).content[0].toolName).toBe("empty_tool_name");
  });

  it("reads apiFormat from provider options when the direct format is absent", () => {
    const messages = toAiSdkMessages(emptyToolMessages(), {
      providerKind: "openai-compatible",
      providerOptions: { apiFormat: "anthropic-messages" },
    });

    expect((messages[0] as any).content[0].toolName).toBe("");
    expect((messages[1] as any).content[0].toolName).toBe("");
  });

  it("falls back only to provider kind and does not infer the format from a URL", () => {
    const anthropic = toAiSdkMessages(emptyToolMessages(), {
      providerKind: "anthropic",
      providerOptions: { baseURL: "https://api.openai.example/v1" },
    });
    const openAiCompatible = toAiSdkMessages(emptyToolMessages(), {
      providerKind: "openai-compatible",
      providerOptions: { baseURL: "https://api.anthropic.example/v1/messages" },
    });

    expect((anthropic[0] as any).content[0].toolName).toBe("");
    expect((anthropic[1] as any).content[0].toolName).toBe("");
    expect((openAiCompatible[0] as any).content[0].toolName).toBe("empty_tool_name");
    expect((openAiCompatible[1] as any).content[0].toolName).toBe("empty_tool_name");
  });

  it.each([
    { toolCallId: undefined, toolName: "Read" },
    { toolCallId: TOOL_CALL_ID, toolName: undefined },
  ])("keeps rejecting incomplete tool-result identity %#", ({ toolCallId, toolName }) => {
    expect(() =>
      toAiSdkMessages([
        {
          role: "tool",
          content: MODEL_CONTENT,
          isError: true,
          toolCallId,
          toolName,
        } as never,
      ]),
    ).toThrow("Tool model messages require toolCallId and toolName");
  });

  it.each([undefined, null, 42, { invalid: true }])(
    "rejects non-string tool name %j at both projection call sites",
    (toolName) => {
      const invalidMessages = [
        [
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: TOOL_CALL_ID, input: {}, name: toolName }],
          },
        ],
        [
          {
            role: "tool",
            content: MODEL_CONTENT,
            isError: true,
            toolCallId: TOOL_CALL_ID,
            toolName,
          },
        ],
      ];

      for (const messages of invalidMessages) {
        let error: unknown;
        try {
          toAiSdkMessages(messages as never);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(AiSdkModelAdapterError);
        expect(error).toMatchObject({
          code: ModelErrorCode.InvalidModelRequest,
          message: "Tool model messages require toolCallId and toolName",
        });
      }
    },
  );

  it("keeps the raw empty name on Anthropic wire", async () => {
    let requestBody: any;
    const provider = createAnthropic({
      apiKey: "fake-key",
      baseURL: "https://api.example.test",
      fetch: captureRejectedRequest((body) => {
        requestBody = body;
      }),
    });
    const messages = toAiSdkMessages(emptyToolMessages(), {
      apiFormat: "anthropic-messages",
      providerKind: "anthropic",
    });

    await expect(
      generateText({ maxRetries: 0, messages, model: provider("anthropic-model") }),
    ).rejects.toBeDefined();

    expect(requestBody.messages).toEqual([
      {
        role: "assistant",
        content: [{ id: TOOL_CALL_ID, input: {}, name: "", type: "tool_use" }],
      },
      {
        role: "user",
        content: [
          {
            content: MODEL_CONTENT,
            is_error: true,
            tool_use_id: TOOL_CALL_ID,
            type: "tool_result",
          },
        ],
      },
    ]);
  });

  it("uses the placeholder only for Chat Completions assistant function name", async () => {
    let requestBody: any;
    const provider = createOpenAICompatible({
      apiKey: "fake-key",
      baseURL: "https://api.example.test/v1",
      name: "empty-name-chat",
      fetch: captureRejectedRequest((body) => {
        requestBody = body;
      }),
    });
    const messages = toAiSdkMessages(emptyToolMessages(), {
      apiFormat: "openai-chat-completions",
      providerKind: "openai-compatible",
    });

    await expect(
      generateText({ maxRetries: 0, messages, model: provider("chat-model") }),
    ).rejects.toBeDefined();

    const assistant = requestBody.messages.find((message: any) => message.role === "assistant");
    const toolResult = requestBody.messages.find((message: any) => message.role === "tool");
    expect(assistant.tool_calls[0]).toMatchObject({
      function: { arguments: "{}", name: "empty_tool_name" },
      id: TOOL_CALL_ID,
      type: "function",
    });
    expect(toolResult).toMatchObject({
      content: MODEL_CONTENT,
      role: "tool",
      tool_call_id: TOOL_CALL_ID,
    });
    expect(toolResult).not.toHaveProperty("name");
  });

  it("uses the placeholder only for Responses function_call name", async () => {
    let requestBody: any;
    const provider = createOpenAI({
      apiKey: "fake-key",
      baseURL: "https://api.example.test/v1",
      fetch: captureRejectedRequest((body) => {
        requestBody = body;
      }),
    });
    const messages = toAiSdkMessages(emptyToolMessages(), {
      apiFormat: "openai-responses",
      providerKind: "openai",
    });

    await expect(
      generateText({ maxRetries: 0, messages, model: provider.responses("responses-model") }),
    ).rejects.toBeDefined();

    const functionCall = requestBody.input.find((item: any) => item.type === "function_call");
    const functionOutput = requestBody.input.find(
      (item: any) => item.type === "function_call_output",
    );
    expect(functionCall).toMatchObject({
      arguments: "{}",
      call_id: TOOL_CALL_ID,
      name: "empty_tool_name",
      type: "function_call",
    });
    expect(functionOutput).toMatchObject({
      call_id: TOOL_CALL_ID,
      output: MODEL_CONTENT,
      type: "function_call_output",
    });
    expect(functionOutput).not.toHaveProperty("name");
  });
});

function emptyToolMessages() {
  return [
    {
      role: "assistant" as const,
      content: "",
      toolCalls: [{ id: TOOL_CALL_ID, input: {}, name: "" }],
    },
    {
      role: "tool" as const,
      content: MODEL_CONTENT,
      isError: true,
      toolCallId: TOOL_CALL_ID,
      toolName: "",
    },
  ];
}

function captureRejectedRequest(
  capture: (body: Record<string, unknown>) => void,
): typeof globalThis.fetch {
  return async (_input, init) => {
    capture(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ error: { message: "wire capture", type: "invalid_request_error" } }),
      {
        headers: { "content-type": "application/json" },
        status: 400,
      },
    );
  };
}
