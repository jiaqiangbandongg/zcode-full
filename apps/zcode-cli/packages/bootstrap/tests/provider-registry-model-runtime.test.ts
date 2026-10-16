import type { CreateAiSdkModelOptions } from "@zcode/adapters/model";
import { ModelErrorCode, ModelProtocolError, type Model } from "@zcode/contracts";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderRegistry,
  ZhipuAccountAccessConfig,
  type Provider,
} from "@zcode/provider";
import { describe, expect, it, vi } from "vitest";
import { ApiProviderModelRuntime } from "../src/app/provider-registry-model-runtime.js";
import {
  createAccountProviderConfig,
  createApiKeyProviderConfig,
} from "./provider-config-fixtures.js";

const properties = new ModelPropertiesConfig({
  requiresMfjsToolSchema: false,
  contextWindow: 200_000,
  inputFormat: {
    supportsText: true,
    supportsImage: true,
    supportsVideo: true,
    supportsAudio: false,
    supportsPdf: false,
  },
  outputFormat: { supportsText: true },
  supportsToolCall: true,
  supportsJsonSchemaOutput: true,
  supportsNativeWebSearch: false,
  supportsMidConversationSystem: true,
});

function modelConfig(): ModelConfig {
  return new ModelConfig({
    enabled: true,
    visibility: "visible",
    properties,
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: {
        values: ["low", "high"],
        map: '{"reasoning_effort":reasoningLevel}',
      },
      maxOutputTokens: {
        max: 32_000,
        map: '{"max_completion_tokens":maxOutputTokens}',
      },
    }),
  });
}

function provider(
  providerId = "api-provider",
  config = createApiKeyProviderConfig({
    apiFormat: "openai-chat-completions",
    apiKey: "test-key",
    baseURL: "https://api.example.com",
    models: ["model-a"],
  }),
): Provider {
  return { providerId, config, models: [{ modelId: "model-a", config: modelConfig() }] };
}

function fakeModel(): Model {
  return {
    providerId: "api-provider" as Model["providerId"],
    modelId: "model-a" as Model["modelId"],
    properties: properties as Model["properties"],
    optionSpecs: modelConfig().optionSpecs as Model["optionSpecs"],
    options: { maxOutputTokens: 8_000 },
    bind() {
      return this;
    },
    async generateText() {
      throw new Error("not used");
    },
    streamText() {
      throw new Error("not used");
    },
  };
}

function selection(providerId = "api-provider") {
  return { providerId, modelId: "model-a", options: { reasoningLevel: "high" } };
}

function captureRuntime(registry: ProviderRegistry) {
  const created: CreateAiSdkModelOptions[] = [];
  const expected = fakeModel();
  const runtime = new ApiProviderModelRuntime({
    registry,
    modelAdapter: {
      createModel(options) {
        created.push(options);
        return expected;
      },
    },
  });
  runtime.start();
  return { created, expected, runtime };
}

describe("ApiProviderModelRuntime", () => {
  it("把 Registry 的完整 Provider / Model Config 原样交给 Adapter", () => {
    const registry = new ProviderRegistry([provider()]);
    const { created, expected, runtime } = captureRuntime(registry);
    expect(runtime.modelFactory({ selection: selection() })).toBe(expected);
    expect(created[0]).toMatchObject({
      providerId: "api-provider",
      modelId: "model-a",
      options: { reasoningLevel: "high" },
    });
    expect(created[0]?.options).not.toHaveProperty("maxOutputTokens");
    expect(created[0]?.providerConfig).toBe(registry.getProvider("api-provider")?.config);
    expect(created[0]?.modelConfig).toBe(registry.getModel("api-provider", "model-a")?.config);
  });

  it("Registry 更新只影响之后创建的 Model", () => {
    const first = provider();
    const registry = new ProviderRegistry([first]);
    const { created, runtime } = captureRuntime(registry);
    runtime.modelFactory({ selection: selection() });
    const second = provider(
      "api-provider",
      createApiKeyProviderConfig({
        apiFormat: "openai-responses",
        apiKey: "second-key",
        baseURL: "https://second.example.com",
        models: ["model-a"],
      }),
    );
    registry.replace([second], "test update");
    runtime.modelFactory({ selection: selection() });
    expect(created[0]?.providerConfig).toBe(first.config);
    expect(created[1]?.providerConfig).toBe(second.config);
  });

  it("Account Provider 直接传递账号访问配置", () => {
    const account = provider(
      "account-provider",
      createAccountProviderConfig({
        apiFormat: "anthropic-messages",
        baseURL: "https://account.example.com",
        models: ["model-a"],
      }),
    );
    const { created, runtime } = captureRuntime(new ProviderRegistry([account]));
    runtime.modelFactory({ selection: selection("account-provider") });
    expect(created[0]?.providerConfig).toBe(account.config);
    expect(created[0]?.providerConfig.access).toMatchObject({
      type: "zhipu-account",
    });
  });

  it("Off-Peak Provider 绑定调用方提供的请求鉴权 Source", () => {
    const requestProvider = provider(
      "request-provider",
      new ProviderConfig({
        access: new ZhipuAccountAccessConfig({ accountType: "zai", mode: "off-peak" }),
        api: new ProviderApiConfig({
          type: "anthropic-messages",
          baseUrl: "https://request.example.com",
        }),
        builtinModelIds: ["model-a"],
        personalModelIds: [],
        visibility: "hidden",
      }),
    );
    const source = { resolve: vi.fn() };
    const { created, runtime } = captureRuntime(new ProviderRegistry([requestProvider]));
    runtime.modelFactory({
      selection: selection("request-provider"),
      requestDependencies: { requestAuth: { source } },
    });
    expect(created[0]?.requestDependencies?.requestAuth?.source).toBe(source);
  });

  it("Highspeed 卡 Provider 同样绑定执行作用域请求鉴权 Source", () => {
    // 回归：加速卡的 access.mode 是 "highspeed"，与 Off-Peak 共用免签网关但凭据是本轮动态
    // 下发的 JWT + 卡 ID header。若这里漏掉 highspeed，source 在创建 Model 时被丢，runner
    // 会在发送前抛 model_request_auth_missing（本轮加速请求根本发不出去）。
    const highspeedProvider = provider(
      "account:bigmodel-highspeed-card",
      new ProviderConfig({
        access: new ZhipuAccountAccessConfig({ accountType: "bigmodel", mode: "highspeed" }),
        api: new ProviderApiConfig({
          type: "anthropic-messages",
          baseUrl: "https://highspeed.example.com",
        }),
        builtinModelIds: ["model-a"],
        personalModelIds: [],
        visibility: "hidden",
      }),
    );
    const source = { resolve: vi.fn() };
    const { created, runtime } = captureRuntime(new ProviderRegistry([highspeedProvider]));
    runtime.modelFactory({
      selection: selection("account:bigmodel-highspeed-card"),
      requestDependencies: { requestAuth: { source } },
    });
    expect(created[0]?.requestDependencies?.requestAuth?.source).toBe(source);
  });

  it("非 Off-Peak / Highspeed 的账号模式不转发执行作用域 Source", () => {
    // 门禁边界：Coding Plan 等静态鉴权模式不消费执行作用域 requestAuth，避免把 source
    // 无条件透传给所有账号 Provider（防止门禁被误放宽成永远转发）。
    const codingPlanProvider = provider(
      "coding-plan-provider",
      createAccountProviderConfig({
        apiFormat: "anthropic-messages",
        baseURL: "https://coding-plan.example.com",
        models: ["model-a"],
        mode: "individual-coding-plan",
      }),
    );
    const source = { resolve: vi.fn() };
    const { created, runtime } = captureRuntime(new ProviderRegistry([codingPlanProvider]));
    runtime.modelFactory({
      selection: selection("coding-plan-provider"),
      requestDependencies: { requestAuth: { source } },
    });
    expect(created[0]?.requestDependencies).toBeUndefined();
  });

  it("Registry 拥有 Provider 时，缺失 Model 不回退旧事实源", () => {
    const { runtime } = captureRuntime(new ProviderRegistry([provider()]));
    expect(() =>
      runtime.modelFactory({
        selection: { providerId: "api-provider", modelId: "missing" },
      }),
    ).toThrow("Provider Registry 中不存在 Model");
  });

  it("缺失 Provider 直接报错", () => {
    const { runtime } = captureRuntime(new ProviderRegistry([provider()]));
    expect(() => runtime.modelFactory({ selection: selection("missing") })).toThrow(
      "Provider Registry 中不存在 Provider: missing",
    );
  });

  it("创建前拒绝不支持的 reasoning level，不进入 Adapter", () => {
    const { created, runtime } = captureRuntime(new ProviderRegistry([provider()]));

    expect(() =>
      runtime.modelFactory({
        selection: {
          providerId: "api-provider",
          modelId: "model-a",
          options: { reasoningLevel: "max" },
        },
      }),
    ).toThrowError(
      expect.objectContaining<ModelProtocolError>({
        code: ModelErrorCode.InvalidModelRequest,
        message: 'Reasoning effort "max" is not supported by api-provider/model-a',
      }),
    );
    expect(created).toEqual([]);
  });
});
