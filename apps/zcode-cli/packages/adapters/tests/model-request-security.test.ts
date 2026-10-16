import { describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { AiSdkModelExecution } from "../src/model/model-execution.js";
import type { ModelRequestSecurityState } from "../src/model/request-security.js";

describe("model request security boundary", () => {
  it("creates one execution scope and passes final model requests through the injected port", async () => {
    const wrapped = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe("/v1/chat/completions");
      expect((await request.json()).model).toBe("example-model");
      return Response.json({
        id: "example",
        object: "chat.completion",
        created: 1,
        model: "example-model",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    });
    const protectTransport = vi.fn(() => wrapped);
    const take = vi.fn(() => []);
    const createExecution = vi.fn(() => ({ protectTransport, take }));
    const state: ModelRequestSecurityState = { createExecution };
    const execution = new AiSdkModelExecution({}, { requestSecurityState: state });
    const bound = execution.bindModel({
      providerId: "example",
      modelId: "example-model",
      supportsJsonSchemaOutput: false,
      optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
      providerConfig: {
        api: { type: "openai-chat-completions", baseUrl: "https://provider.example.test/v1" },
        access: { type: "api-key", apiKey: "example-key" },
      },
    });
    const resolved = bound.resolveRequest({
      options: { reasoningLevel: "disabled", maxOutputTokens: 32 },
    });
    expect((await generateText({ model: resolved.model, prompt: "hello" })).text).toBe("ok");
    expect(createExecution).toHaveBeenCalledOnce();
    expect(protectTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "example",
        providerConfig: expect.objectContaining({ apiKey: "example-key" }),
      }),
    );
    expect(wrapped).toHaveBeenCalledOnce();
    expect(resolved.requestObservations).toBe(createExecution.mock.results[0]?.value);
  });
});
