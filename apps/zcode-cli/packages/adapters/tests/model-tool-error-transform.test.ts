import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { toAiSdkMessages } from "../src/model/index.js";

describe("AI SDK model tool result error transform", () => {
  it("maps provider-neutral failed tool results to AI SDK error output", () => {
    const toolCallId = "call_failed_tool";
    const messages = toAiSdkMessages([
      {
        role: "tool",
        content: "Command was aborted before completion",
        isError: true,
        toolCallId,
        toolName: "Bash",
      },
    ]);

    expect((messages[0] as any).content[0]).toEqual({
      type: "tool-result",
      toolCallId,
      toolName: "Bash",
      output: {
        type: "error-text",
        value: "Command was aborted before completion",
      },
    });
  });

  it("serializes failed tool results as Anthropic is_error tool_result blocks", async () => {
    let requestBody: any;
    const provider = createAnthropic({
      apiKey: "fake-key",
      baseURL: "https://api.example.test",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ error: { message: "wire capture", type: "invalid_request_error" } }),
          {
            headers: { "content-type": "application/json" },
            status: 400,
          },
        );
      },
    });
    const toolCallId = "call_malformed_ask";
    const validationContent = [
      "<tool_use_error>InputValidationError: AskUserQuestion failed due to the following issue:",
      "The required parameter `questions` is missing</tool_use_error>",
    ].join("\n");
    const messages = toAiSdkMessages([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: toolCallId,
            input: {},
            name: "AskUserQuestion",
          },
        ],
      },
      {
        role: "tool",
        content: validationContent,
        isError: true,
        toolCallId,
        toolName: "AskUserQuestion",
      },
    ]);

    await expect(
      generateText({
        messages,
        model: provider("anthropic-model"),
      }),
    ).rejects.toBeDefined();

    expect(requestBody.messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            id: toolCallId,
            input: {},
            name: "AskUserQuestion",
            type: "tool_use",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            content: validationContent,
            is_error: true,
            tool_use_id: toolCallId,
            type: "tool_result",
          },
        ],
      },
    ]);
  });
});
