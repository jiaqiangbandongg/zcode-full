import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createGenerateTextOptions } from "../src/model/runner-options.js";
import { createTestModelProperties } from "./test-model-format.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";

describe("OpenAI-compatible empty user wire shape", () => {
  it("sends the fixed fallback instead of an ASCII-space user prompt", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatible({
      apiKey: "fake-ak",
      baseURL: "https://api.example.test/v1",
      name: "Compatible Empty User E2E",
      fetch: async (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new Error("Expected a JSON request body");
        }
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "ok", role: "assistant" } }],
            id: "chatcmpl-empty-user",
            model: "legacy-chat-template",
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const options = createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [
          {
            role: "user",
            content:
              '<system-reminder>\nCalled the Read tool with the following input: {"file_path":"notes.md"}\n</system-reminder>',
          },
          {
            role: "user",
            content:
              "<system-reminder>\nResult of calling the Read tool:\n1\tattachment text\n</system-reminder>",
          },
          { role: "user", content: "" },
        ],
      },
      resolved: {
        baseURL: "https://api.example.test/v1",
        model: provider("legacy-chat-template"),
        providerKind: "openai-compatible",
        properties: createTestModelProperties(),
        providerId: "legacy-compatible",
        modelId: "legacy-chat-template",
      } as ResolvedAiSdkModel,
      statusContext: {
        providerId: "legacy-compatible",
        modelId: "legacy-chat-template",
        providerKind: "openai-compatible",
        requestId: "req_empty_user_wire",
        sessionId: "sess_empty_user_wire",
        traceId: "trace_empty_user_wire",
      } as never,
    });

    await generateText(options);

    const messages = capturedBody?.messages as
      | Array<{ role?: unknown; content?: unknown }>
      | undefined;
    expect(messages).toEqual([
      {
        role: "user",
        content:
          '<system-reminder>\nCalled the Read tool with the following input: {"file_path":"notes.md"}\n</system-reminder>',
      },
      {
        role: "user",
        content:
          "<system-reminder>\nResult of calling the Read tool:\n1\tattachment text\n</system-reminder>",
      },
      { role: "user", content: "(no content)" },
    ]);
    expect(messages?.some((message) => message.role === "user" && message.content === " ")).toBe(
      false,
    );
  });
});
