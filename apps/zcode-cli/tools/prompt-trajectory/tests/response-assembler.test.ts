import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assembleNonStreamingAssistantMessage,
  assembleStreamingAssistantMessage,
} from "../src/openai-response-assembler.js";

describe("OpenAI response assembler", () => {
  it("extracts a non-streaming assistant message", () => {
    deepStrictEqual(
      assembleNonStreamingAssistantMessage({
        choices: [
          {
            message: {
              role: "assistant",
              content: "hello",
            },
          },
        ],
      }),
      {
        role: "assistant",
        content: "hello",
      },
    );
  });

  it("assembles streaming text and tool call deltas into one assistant message", () => {
    const chunks = [
      'data: {"choices":[{"delta":{"role":"assistant","content":"hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Read","arguments":"{\\"path\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"a.ts\\"}"}}]}}]}\n\n',
      "data: [DONE]\n\n",
    ];

    deepStrictEqual(assembleStreamingAssistantMessage(chunks), {
      role: "assistant",
      content: "hello",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "Read",
            arguments: "{\"path\":\"a.ts\"}",
          },
        },
      ],
    });
  });
});
