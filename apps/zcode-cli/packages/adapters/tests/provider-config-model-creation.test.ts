import { describe, expect, it, vi } from "vitest";
import type { ModelNetworkStatusEvent } from "@zcode/contracts";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelInputFormatConfig,
  ModelOptionSpecsConfig,
  ModelOutputFormatConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  type RegistryModelConfig,
  type RegistryProviderConfig,
} from "@zcode/provider";
import { AiSdkModelAdapter } from "../src/model/runner.js";
import type { AiSdkModelRuntime } from "../src/model/runner-runtime.js";

describe("AiSdkModelAdapter Provider Config creation", () => {
  it("keeps option maps out of duplicate AI SDK provider options", async () => {
    const requests: Array<{ providerOptions?: Record<string, unknown> }> = [];
    const statusEvents: ModelNetworkStatusEvent[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        requests.push(options);
        return {
          finishReason: "stop",
          text: "done",
          totalUsage: {},
          usage: {},
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const providerConfig = new ProviderConfig({
      access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
      api: new ProviderApiConfig({
        type: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
      builtinModelIds: ["gpt-5.6-sol"],
      enabled: true,
      id: "openai",
      personalModelIds: [],
      name: "OpenAI",
      visibility: "visible",
    }) as RegistryProviderConfig;
    const modelConfig = new ModelConfig({
      enabled: true,

      properties: new ModelPropertiesConfig({
        requiresMfjsToolSchema: false,
        contextWindow: 1_050_000,
        inputFormat: new ModelInputFormatConfig({
          supportsText: true,
          supportsImage: true,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: true,
        }),
        outputFormat: new ModelOutputFormatConfig({ supportsText: true }),
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      }),
      optionSpecs: new ModelOptionSpecsConfig({
        reasoningLevel: {
          values: ["none", "low", "medium", "high", "xhigh", "max"],
          map: '{"reasoning":{"effort":reasoningLevel}}',
        },
        maxOutputTokens: {
          max: 128_000,
          map: '{"max_output_tokens":maxOutputTokens}',
        },
      }),
    }) as RegistryModelConfig;
    const adapter = new AiSdkModelAdapter({
      runtime,
      statusSink: { publish: (event) => statusEvents.push(event) },
    });
    const model = adapter.createModel({
      providerId: "openai",
      modelId: "gpt-5.6-sol",
      providerConfig,
      modelConfig,
      options: { maxOutputTokens: 128_000, reasoningLevel: "max" },
    });

    await model.generateText({ messages: [{ role: "user", content: "hello" }] });
    await model.generateText({
      messages: [{ role: "user", content: "summarize cheaply" }],
      options: { reasoningLevel: "none" },
    });

    expect(requests.map((request) => request.providerOptions)).toEqual([
      { apiFormat: "openai-responses" },
      { apiFormat: "openai-responses" },
    ]);
    expect(model.options).toEqual({ maxOutputTokens: 128_000, reasoningLevel: "max" });
    expect(
      statusEvents
        .filter((event) => event.type === "model_request_started")
        .map((event) => event.modelCall.reasoning),
    ).toEqual([
      expect.objectContaining({
        requestedControl: "provider_default",
        requestedLevel: "max",
        requestedState: "provider_default",
      }),
      expect.objectContaining({
        requestedControl: "provider_default",
        requestedLevel: "none",
        requestedState: "provider_default",
      }),
    ]);
  });

  it("directly consumes complete Registry Config and freezes it for the created Model", async () => {
    const receivedModels: unknown[] = [];
    const runtime: AiSdkModelRuntime = {
      async generateText(options) {
        receivedModels.push(options.model);
        return {
          finishReason: "stop",
          text: "done",
          totalUsage: {},
          usage: {},
        } as never;
      },
      streamText() {
        throw new Error("not used");
      },
    };
    const providerConfig = new ProviderConfig({
      access: new ApiKeyAccessConfig({ apiKey: "first-key" }),
      api: new ProviderApiConfig({
        type: "openai-responses",
        baseUrl: "https://first.example.com/v1",
      }),
      builtinModelIds: ["model-a"],
      enabled: true,
      id: "provider-a",
      personalModelIds: [],
      name: "Provider A",
      visibility: "visible",
    }) as RegistryProviderConfig;
    const modelConfig = new ModelConfig({
      enabled: true,

      properties: new ModelPropertiesConfig({
        requiresMfjsToolSchema: false,
        contextWindow: 128_000,
        inputFormat: new ModelInputFormatConfig({
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        }),
        outputFormat: new ModelOutputFormatConfig({ supportsText: true }),
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      }),
      optionSpecs: new ModelOptionSpecsConfig({
        reasoningLevel: {
          values: ["disabled"],
          map: "{}",
        },
        maxOutputTokens: {
          max: 16_000,
          map: '{"max_output_tokens":maxOutputTokens}',
        },
      }),
    }) as RegistryModelConfig;
    const adapter = new AiSdkModelAdapter({ runtime });

    const model = adapter.createModel({
      providerId: "provider-a",
      modelId: "model-a",
      providerConfig,
      modelConfig,
      options: { maxOutputTokens: 8_000, reasoningLevel: "disabled" },
    });
    await model.generateText({ messages: [{ role: "user", content: "hello" }] });

    expect(receivedModels).toHaveLength(1);
    expect(model.properties.contextWindow).toBe(128_000);
    expect(model.options.maxOutputTokens).toBe(8_000);
  });

  it("does not expose a mutable execution Registry API", () => {
    const adapter = new AiSdkModelAdapter({});

    expect(adapter).not.toHaveProperty("replaceRegistryConfig");
    expect(adapter).not.toHaveProperty("resolveConnection");
  });
});
