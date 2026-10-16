import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createGenerateTextOptions } from "../src/model/runner-options.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";
import { createTestModelProperties } from "./test-model-format.js";

describe("OpenAI-compatible system message wire shape", () => {
  it.each([
    {
      expectedSystem: "cli prefix\nstable context\n\ndynamic context",
      name: "concatenates self-delimited Main blocks without adding separators",
      systemMessages: [
        { role: "system", content: "cli prefix" },
        { role: "system", content: "\nstable context" },
        { role: "system", content: "\n\ndynamic context" },
      ],
    },
    {
      expectedSystem:
        "cli prefix\nsubagent prompt\n\nNotes:\n\nHere is useful environment information",
      name: "concatenates self-delimited Subagent blocks without adding separators",
      systemMessages: [
        { role: "system", content: "cli prefix" },
        { role: "system", content: "\nsubagent prompt" },
        { role: "system", content: "\n\nNotes:" },
        { role: "system", content: "\n\nHere is useful environment information" },
      ],
    },
    {
      expectedSystem: "cli prefix\n\nNotes:\n\nHere is useful environment information",
      name: "preserves Subagent boundaries when the optional agent prompt is absent",
      systemMessages: [
        { role: "system", content: "cli prefix" },
        { role: "system", content: "\n\nNotes:" },
        { role: "system", content: "\n\nHere is useful environment information" },
      ],
    },
  ] as const)("$name", async ({ expectedSystem, systemMessages }) => {
    let capturedBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatible({
      apiKey: "fake-ak",
      baseURL: "https://api.example.test/v1",
      name: "Compatible System E2E",
      fetch: async (_input, init) => {
        if (typeof init?.body !== "string") {
          throw new Error("Expected a JSON request body");
        }
        capturedBody = JSON.parse(init.body) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "ok", role: "assistant" } }],
            id: "chatcmpl-system-merge",
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
          ...systemMessages,
          { role: "user", content: "first question" },
          { role: "assistant", content: "first answer" },
          { role: "user", content: "follow-up" },
        ],
      },
      resolved: {
        properties: createTestModelProperties(),
        baseURL: "https://api.example.test/v1",
        model: provider("legacy-chat-template"),
        providerKind: "openai-compatible",
        providerId: "legacy-compatible",
        modelId: "legacy-chat-template",
      } as ResolvedAiSdkModel,
      statusContext: {
        providerId: "legacy-compatible",
        modelId: "legacy-chat-template",
        providerKind: "openai-compatible",
        requestId: "req_system_merge_wire",
        sessionId: "sess_system_merge_wire",
        traceId: "trace_system_merge_wire",
      } as never,
    });

    await generateText(options);

    expect(capturedBody?.messages).toEqual([
      {
        role: "system",
        content: expectedSystem,
      },
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "follow-up" },
    ]);
  });
});
