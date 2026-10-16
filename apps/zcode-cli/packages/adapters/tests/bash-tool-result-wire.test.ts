import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { toAiSdkMessages } from "../src/model/index.js";

const FOREGROUND_CONTENT = "stdout-1\nstderr-1\nstdout-2";
const BACKGROUND_CONTENT =
  "Command running in background with ID: exec_bg. Output is being written to: /tmp/exec_bg-stdout.log. You will be notified when it completes. To check interim output, use Read on that file path.";
const NOTIFICATION_CONTENT = [
  "<task-notification>",
  "<task-id>exec_bg</task-id>",
  "<tool-use-id>call_bash_background</tool-use-id>",
  "<output-file>/tmp/exec_bg-stdout.log</output-file>",
  "<status>completed</status>",
  '<summary>Background command "long command" completed (exit code 0)</summary>',
  "</task-notification>",
].join("\n");

const TOOL_CALLS = [
  {
    id: "call_bash_foreground",
    input: { command: "mixed output" },
    name: "Bash",
  },
  {
    id: "call_bash_background",
    input: { command: "long command", run_in_background: true },
    name: "Bash",
  },
];

function bashMessages() {
  return toAiSdkMessages([
    {
      role: "assistant",
      content: "",
      toolCalls: TOOL_CALLS,
    },
    {
      role: "tool",
      content: FOREGROUND_CONTENT,
      toolCallId: TOOL_CALLS[0]!.id,
      toolName: "Bash",
    },
    {
      role: "tool",
      content: BACKGROUND_CONTENT,
      toolCallId: TOOL_CALLS[1]!.id,
      toolName: "Bash",
    },
    {
      role: "user",
      content: NOTIFICATION_CONTENT,
    },
  ]);
}

describe("Bash provider-visible tool result wire", () => {
  it("preserves Bash content in Anthropic tool_result blocks", async () => {
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

    await expect(
      generateText({
        messages: bashMessages(),
        model: provider("anthropic-model"),
      }),
    ).rejects.toBeDefined();

    expect(requestBody.messages[1]).toEqual({
      role: "user",
      content: [
        {
          content: FOREGROUND_CONTENT,
          tool_use_id: TOOL_CALLS[0]!.id,
          type: "tool_result",
        },
        {
          content: BACKGROUND_CONTENT,
          tool_use_id: TOOL_CALLS[1]!.id,
          type: "tool_result",
        },
        {
          text: NOTIFICATION_CONTENT,
          type: "text",
        },
      ],
    });
  });

  it("preserves Bash content in OpenAI-compatible tool messages", async () => {
    let requestBody: any;
    const provider = createOpenAICompatible({
      apiKey: "fake-key",
      baseURL: "https://api.example.test/v1",
      name: "Bash wire capture",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "ok", role: "assistant" } }],
            id: "chatcmpl-bash-wire",
            model: "compatible-model",
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    await generateText({
      messages: bashMessages(),
      model: provider("compatible-model"),
    });

    expect(requestBody.messages.slice(1)).toEqual([
      {
        role: "tool",
        content: FOREGROUND_CONTENT,
        tool_call_id: TOOL_CALLS[0]!.id,
      },
      {
        role: "tool",
        content: BACKGROUND_CONTENT,
        tool_call_id: TOOL_CALLS[1]!.id,
      },
      {
        role: "user",
        content: NOTIFICATION_CONTENT,
      },
    ]);
  });
});
