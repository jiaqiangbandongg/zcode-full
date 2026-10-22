import { AiSdkModelAdapter } from "@zcode/adapters/model";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderRegistry,
} from "@zcode/provider";
import { ApiProviderModelRuntime } from "../../src/app/provider-registry-model-runtime.js";
import { createApiKeyProviderConfig } from "../provider-config-fixtures.js";

// 旧注册器已经退场；PDF 真实请求测试复用 App 的 Registry 到 Model 装配边界。
export function createPdfProviderFixture(
  baseURL: string,
  providerId: string,
  models: Array<{ modelId: string; supportsPdf: boolean }>,
) {
  const registry = new ProviderRegistry([
    {
      providerId,
      config: createApiKeyProviderConfig({
        apiFormat: "openai-chat-completions",
        baseURL: `${baseURL}/v1`,
        apiKey: "pdf-e2e-key",
        models: models.map((model) => model.modelId),
      }),
      models: models.map(({ modelId, supportsPdf }) => ({
        modelId,
        config: new ModelConfig({
          enabled: true,
          visibility: "visible",
          properties: new ModelPropertiesConfig({
            requiresMfjsToolSchema: false,
            contextWindow: 128_000,
            inputFormat: {
              supportsText: true,
              supportsImage: true,
              supportsPdf,
              supportsVideo: false,
              supportsAudio: false,
            },
            outputFormat: { supportsText: true },
            supportsToolCall: true,
            supportsJsonSchemaOutput: true,
            supportsNativeWebSearch: false,
            supportsMidConversationSystem: true,
          }),
          optionSpecs: new ModelOptionSpecsConfig({
            reasoningLevel: { values: ["disabled"], map: "{}" },
            maxOutputTokens: { max: 16_000, map: '{"max_tokens":maxOutputTokens}' },
          }),
        }),
      })),
    },
  ]);
  const modelRuntime = new ApiProviderModelRuntime({
    registry,
    modelAdapter: new AiSdkModelAdapter({ env: {}, retry: { maxAttempts: 1 } }),
  });
  modelRuntime.start();
  return { registry, modelFactory: modelRuntime.modelFactory };
}
