import { updateModelDraft } from "@/settings/model-provider-section/ProviderModelDraftState.js";
import { extractManualModelConfig } from "@zcode/provider";
import { describe, expect, it } from "vitest";
import type {
  ProviderSettingsFormModel,
  ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import {
  resolvePendingProviderDraftSave,
  type ProviderDraftValues,
} from "@/settings/model-provider-section/ProviderDraftSave.js";
import {
  createProviderModelDraftValues,
  resolveProviderModelDraftCommit,
} from "@/settings/model-provider-section/ProviderModelMetadata.js";

function createProvider(
  overrides: Partial<ProviderSettingsFormProvider> = {},
): ProviderSettingsFormProvider {
  return {
    providerId: "provider-demo",
    providerName: "Demo Provider",
    executable: true,
    enabled: true,
    hasPersonalConfig: true,
    personalConfig: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "sk-old" },
      api: { type: "anthropic-messages", baseUrl: "https://old.example.com/v1" },
      personalModelIds: ["demo-model"],
      enabled: true,
    },
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: "sk-old" },
      api: {
        type: "anthropic-messages",
        baseUrl: "https://old.example.com/v1",
        headers: { "x-old": "remove-on-edit" },
      },
      personalModelIds: ["demo-model"],
      enabled: true,
    },
    models: [
      {
        kind: "candidate",
        modelId: "demo-model",
        builtin: false,
        personalConfig: {},
        config: {},
        hasPersonalConfig: true,
        executable: true,
        selectable: true,
      },
    ],
    ...overrides,
  };
}

function createDraft(overrides: Partial<ProviderDraftValues> = {}): ProviderDraftValues {
  return {
    nameValue: "Demo Provider",
    apiFormat: "openai-chat-completions",
    baseUrlValue: "https://new.example.com/v1/chat/completions",
    apiKeyValue: "sk-new",
    ...overrides,
  };
}

describe("Provider draft uses formal Provider Config", () => {
  it("套餐 Key 编辑保留 Access 类型，不物化模板管理入口", () => {
    const provider = createProvider({
      personalConfig: {},
      config: {
        group: "standard-personal",
        access: {
          type: "zhipu-coding-plan-api-key",
          apiKey: "old",
          apiKeyManagementUrl: "https://z.ai/manage-apikey/apikey-list",
        },
        api: { type: "anthropic-messages", baseUrl: "https://api.z.ai/api/anthropic" },
      },
    });
    const result = resolvePendingProviderDraftSave({
      provider,
      draft: createDraft({
        apiFormat: "anthropic-messages",
        baseUrlValue: "https://api.z.ai/api/anthropic",
        apiKeyValue: "new",
      }),
      now: () => 0,
    });
    expect(result?.personalConfig).toEqual({
      access: { type: "zhipu-coding-plan-api-key", apiKey: "new" },
    });
    expect(result?.config.access).toEqual({ ...provider.config.access, apiKey: "new" });
  });
  it("Todo89：显示用 ID 和默认 API 类型不构成用户编辑", () => {
    const provider = createProvider({
      providerName: undefined,
      config: { group: "standard-personal" },
      personalConfig: { group: "standard-personal" },
    });
    expect(
      resolvePendingProviderDraftSave({
        provider,
        draft: {
          nameValue: provider.providerId,
          apiFormat: "anthropic-messages",
          baseUrlValue: "",
          apiKeyValue: "",
        },
        now: () => 0,
      }),
    ).toBeNull();
  });
  it("Todo89：未编辑不保存；只编辑名称不能物化连接或丢失 headers", () => {
    const provider = createProvider({ personalConfig: {} });
    const draft = createDraft({
      apiFormat: "anthropic-messages",
      baseUrlValue: "https://old.example.com/v1",
      apiKeyValue: "sk-old",
    });
    expect(resolvePendingProviderDraftSave({ provider, draft, now: () => 0 })).toBeNull();
    const renamed = resolvePendingProviderDraftSave({
      provider,
      draft: { ...draft, nameValue: "Renamed" },
      nameConfirmed: true,
      now: () => 0,
    });
    expect(renamed?.personalConfig).toEqual({});
    expect(renamed?.providerNameUpdate).toBe("Renamed");
    expect(renamed?.config.api?.headers).toEqual(provider.config.api?.headers);
  });

  it("Todo89：修改 API 地址保留个人 headers，不复制继承 headers", () => {
    const provider = createProvider();
    provider.personalConfig.api = {
      ...provider.personalConfig.api,
      headers: { "x-personal": "kept" },
    };
    const saved = resolvePendingProviderDraftSave({ provider, draft: createDraft(), now: () => 0 });
    expect(saved?.personalConfig.api?.headers).toEqual({ "x-personal": "kept" });
  });
  it("Personal-only Provider 编辑连接信息时保存可编辑名称", () => {
    const result = resolvePendingProviderDraftSave({
      provider: createProvider(),
      draft: createDraft({ nameValue: "Renamed" }),
      nameConfirmed: true,
      now: () => 2,
    });

    expect(result?.providerNameUpdate).toBe("Renamed");
    expect(result?.config).toEqual({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "sk-new" },
      api: {
        type: "openai-chat-completions",
        baseUrl: "https://new.example.com/v1/chat/completions",
        headers: { "x-old": "remove-on-edit" },
      },
      personalModelIds: ["demo-model"],
      enabled: true,
    });
  });

  it("只读连接只更新名称与 API Key", () => {
    const provider = createProvider();
    const result = resolvePendingProviderDraftSave({
      provider,
      draft: createDraft({ nameValue: "", baseUrlValue: "https://ignored.example" }),
      readOnlyEndpoints: true,
      nameConfirmed: true,
      now: () => 2,
    });

    expect(result?.config).not.toHaveProperty("label");
    expect(result?.providerNameUpdate).toBeNull();
    expect(result?.config.api).toEqual(provider.config.api);
    expect(result?.config.access).toEqual({ type: "api-key", apiKey: "sk-new" });
  });

  it("未确认的名称不会被连接草稿保存夹带", () => {
    const provider = createProvider();
    const saved = resolvePendingProviderDraftSave({
      provider,
      draft: createDraft({ nameValue: "Unconfirmed" }),
      now: () => 0,
    });
    expect(saved?.providerName).toBe(provider.providerName);
    expect(saved).not.toHaveProperty("providerNameUpdate");
    expect(saved?.config.access).toMatchObject({ apiKey: "sk-new" });
  });

  it("没有变化时不产生保存对象", () => {
    const provider = createProvider({
      config: {
        group: "standard-personal",
        access: { type: "api-key", apiKey: "sk-old" },
        api: { type: "anthropic-messages", baseUrl: "https://old.example.com/v1" },
        personalModelIds: ["demo-model"],
        enabled: true,
      },
    });
    expect(
      resolvePendingProviderDraftSave({
        provider,
        draft: createDraft({
          apiFormat: "anthropic-messages",
          baseUrlValue: "https://old.example.com/v1",
          apiKeyValue: "sk-old",
        }),
        now: () => 2,
      }),
    ).toBeNull();
  });

  it("空 Base URL 保存为缺省字段而不是非法 URL", () => {
    const result = resolvePendingProviderDraftSave({
      provider: createProvider(),
      draft: createDraft({ baseUrlValue: "" }),
      now: () => 2,
    });

    expect(result?.config.api).toEqual({
      type: "openai-chat-completions",
      headers: { "x-old": "remove-on-edit" },
    });
    expect(result?.personalConfig.api).toEqual({ type: "openai-chat-completions" });
  });
});

describe("Model metadata uses formal Model Config", () => {
  function createModel(): ProviderSettingsFormModel {
    return {
      kind: "candidate",
      modelId: "demo-model",
      builtin: true,
      inheritedConfig: {
        enabled: true,

        properties: {
          requiresMfjsToolSchema: false,
          contextWindow: 128_000,
          inputFormat: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
          outputFormat: { supportsText: true },
          supportsToolCall: true,
          supportsJsonSchemaOutput: true,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: false,
        },
        optionSpecs: {
          reasoningLevel: {
            values: ["low", "high"],
            map: "{'reasoning_effort': reasoningLevel}",
          },
          maxOutputTokens: {
            max: 32_000,
            map: "{'max_completion_tokens': maxOutputTokens}",
          },
        },
      },
      personalConfig: {},
      hasPersonalConfig: false,
      executable: true,
      selectable: true,
      config: {
        properties: {
          requiresMfjsToolSchema: false,
          contextWindow: 128_000,
          inputFormat: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
          outputFormat: { supportsText: true },
          supportsToolCall: true,
          supportsJsonSchemaOutput: true,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: false,
        },
        optionSpecs: {
          reasoningLevel: {
            values: ["low", "high"],
            map: "{'reasoning_effort': reasoningLevel}",
          },
          maxOutputTokens: {
            max: 32_000,
            map: "{'max_completion_tokens': maxOutputTokens}",
          },
        },
      },
    };
  }

  it("编辑草稿只预填 Personal 覆盖，不把继承容量伪装成用户输入", () => {
    expect(createProviderModelDraftValues(createModel())).toMatchObject({
      idValue: "demo-model",
      contextWindowValue: "",
      maxOutputTokensValue: "",
      enabledValue: true,
      supportsJsonSchemaOutputValue: true,
      supportsNativeWebSearchValue: false,
      supportsMidConversationSystemValue: false,

      inputFormatValue: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },

      reasoningLevelValuesValue: ["low", "high"],
      reasoningLevelMapValue: "",
    });
  });

  it("Todo130：手动保存只冻结可编辑字段，不要求/保存隐藏映射或工具能力", () => {
    const model = createModel();
    model.config = {
      ...model.config,
      optionSpecs: { ...model.config.optionSpecs, maxOutputTokens: { max: 32000 } },
    };
    const draft = updateModelDraft(
      createProviderModelDraftValues(model),
      { useRecommendedConfigValue: false },
      model,
    );
    const result = resolveProviderModelDraftCommit({ currentModel: model, draft });
    expect(result.status).toBe("commit");
    if (result.status !== "commit") return;
    expect(result.model.personalConfig.properties).not.toHaveProperty("supportsToolCall");
    expect(result.model.personalConfig.properties).not.toHaveProperty("outputFormat");
    expect(result.model.personalConfig.properties?.inputFormat).toEqual({
      supportsImage: false,
      supportsVideo: false,
      supportsPdf: false,
    });
    expect(result.model.personalConfig.optionSpecs?.maxOutputTokens).toEqual({ max: 32000 });
    expect(result.model.personalConfig).not.toHaveProperty("enabled");
  });

  it("已有 Personal 容量覆盖继续作为真实输入值", () => {
    const model = createModel();
    model.personalConfig = {
      properties: { contextWindow: 64_000 },
      optionSpecs: { maxOutputTokens: { max: 8_000 } },
    };

    expect(createProviderModelDraftValues(model)).toMatchObject({
      contextWindowValue: "64000",
      maxOutputTokensValue: "8000",
    });
  });

  it("显式移除的数值是待修复空输入，不显示 null 字符串", () => {
    const model = createModel();
    model.personalConfig = {
      properties: { contextWindow: null },
      optionSpecs: { maxOutputTokens: { max: null } },
    };
    expect(createProviderModelDraftValues(model)).toMatchObject({
      contextWindowValue: "",
      maxOutputTokensValue: "",
    });
  });

  it("关闭跟随推荐配置时物化当前 Effective 的编辑器字段", () => {
    const result = resolveProviderModelDraftCommit({
      currentModel: createModel(),
      draft: updateModelDraft(
        createProviderModelDraftValues(createModel()),
        { useRecommendedConfigValue: false },
        createModel(),
      ),
    });

    expect(result.status).toBe("commit");
    if (result.status !== "commit") return;
    expect(result.model.useRecommendedConfig).toBe(false);
    const { enabled: _enabled, ...manual } = extractManualModelConfig(result.model.config);
    expect(result.model.personalConfig).toEqual(manual);
    expect(result.model.personalConfig).not.toHaveProperty("enabled");
  });

  it("缺少模式字段时默认跟随推荐配置", () => {
    expect(createProviderModelDraftValues(createModel()).useRecommendedConfigValue).toBe(true);
  });

  it("固定配置不能删除已有的禁用覆盖", () => {
    const model = createModel();
    model.personalConfig = { enabled: false };
    model.config = { ...model.config, enabled: false };
    const result = resolveProviderModelDraftCommit({
      currentModel: model,
      draft: updateModelDraft(
        createProviderModelDraftValues(model),
        { useRecommendedConfigValue: false },
        model,
      ),
    });
    expect(result.status).toBe("commit");
    if (result.status === "commit") expect(result.model.personalConfig.enabled).toBe(false);
  });

  it("切回跟随之后新输入的值仍能保存", () => {
    const model = createModel();
    model.personalConfig = { enabled: false, properties: { contextWindow: 64_000 } };
    const reset = createProviderModelDraftValues({
      ...model,
      personalConfig: {},
      config: model.inheritedConfig!,
    });
    const result = resolveProviderModelDraftCommit({
      currentModel: model,
      draft: {
        ...reset,
        contextWindowValue: "96000",
        useRecommendedConfigValue: true,
        clearPersonalConfigValue: true,
      },
    });
    expect(result.status).toBe("commit");
    if (result.status === "commit")
      expect(result.model.personalConfig).toMatchObject({
        enabled: false,
        properties: { contextWindow: 96_000 },
      });
  });

  it("固定模式缺少最大输出的完整配置时禁止提交", () => {
    const model = createModel();
    model.config.optionSpecs = { reasoningLevel: model.config.optionSpecs!.reasoningLevel };
    model.inheritedConfig!.optionSpecs = {
      reasoningLevel: model.inheritedConfig!.optionSpecs!.reasoningLevel,
    };
    expect(
      resolveProviderModelDraftCommit({
        currentModel: model,
        draft: updateModelDraft(
          createProviderModelDraftValues(model),
          { useRecommendedConfigValue: false },
          model,
        ),
      }),
    ).toEqual({ status: "invalid", field: "maxOutputTokens" });
  });

  it("从固定模式切回跟随时清空旧 Overlay，但保留模型启用状态", () => {
    const model = createModel();
    model.personalConfig = {
      enabled: false,
      properties: { contextWindow: 64_000 },
    };
    const result = resolveProviderModelDraftCommit({
      currentModel: model,
      draft: {
        ...createProviderModelDraftValues({
          ...model,
          personalConfig: {},
          config: model.inheritedConfig!,
        }),
        useRecommendedConfigValue: true,
        clearPersonalConfigValue: true,
      },
    });

    expect(result.status).toBe("commit");
    if (result.status !== "commit") return;
    expect(result.model.personalConfig).toEqual({ enabled: false });
    expect(result.model.useRecommendedConfig).toBe(true);
  });

  it("高级字段写入稀疏 Personal Rule，最大输出由唯一数字入口确定", () => {
    const result = resolveProviderModelDraftCommit({
      currentModel: createModel(),
      draft: {
        ...createProviderModelDraftValues(createModel()),
        enabledValue: false,
        supportsNativeWebSearchValue: true,

        maxOutputTokensValue: "12000",
        reasoningLevelValuesValue: ["none", "high"],
        reasoningLevelMapValue: "{'reasoning_effort': reasoningLevel}",
      },
    });

    expect(result.status).toBe("commit");
    if (result.status !== "commit") return;
    expect(result.model.personalConfig).toMatchObject({
      enabled: false,

      properties: {
        supportsNativeWebSearch: true,
      },
      optionSpecs: {
        reasoningLevel: { values: ["none", "high"] },
        maxOutputTokens: { max: 12_000 },
      },
    });
  });

  it("推理档位为空或重复时保留草稿并拒绝提交", () => {
    expect(
      resolveProviderModelDraftCommit({
        currentModel: createModel(),
        draft: {
          ...createProviderModelDraftValues(createModel()),
          reasoningLevelValuesValue: ["low", "low"],
        },
      }),
    ).toEqual({ status: "invalid", field: "reasoningLevelValues" });
  });

  it("Reasoning Mapping 使用 Personal value，清空后恢复继承", () => {
    const currentModel = createModel();
    currentModel.personalConfig = {
      optionSpecs: { reasoningLevel: { map: "{'thinking': {'type': 'enabled'}}" } },
    };
    currentModel.config = {
      ...currentModel.config,
      optionSpecs: {
        ...currentModel.config.optionSpecs,
        reasoningLevel: {
          ...currentModel.config.optionSpecs!.reasoningLevel!,
          map: "{'thinking': {'type': 'enabled'}}",
        },
      },
    };

    expect(createProviderModelDraftValues(currentModel).reasoningLevelMapValue).toBe(
      "{'thinking': {'type': 'enabled'}}",
    );
    const result = resolveProviderModelDraftCommit({
      currentModel,
      draft: { ...createProviderModelDraftValues(currentModel), reasoningLevelMapValue: "" },
    });

    expect(result.status).toBe("commit");
    if (result.status !== "commit") return;
    expect(result.model.personalConfig.optionSpecs?.reasoningLevel?.map).toBeUndefined();
    expect(result.model.config.optionSpecs?.reasoningLevel?.map).toBe(
      "{'reasoning_effort': reasoningLevel}",
    );
  });

  it("拒绝无法编译的 Reasoning Mapping", () => {
    expect(
      resolveProviderModelDraftCommit({
        currentModel: createModel(),
        draft: {
          ...createProviderModelDraftValues(createModel()),
          reasoningLevelMapValue: "reasoningLevel ??? {}",
        },
      }),
    ).toEqual({ status: "invalid", field: "reasoningLevelMap" });
  });

  it("清空上下文窗口时恢复继承值并删除 Personal 叶子", () => {
    const currentModel = createModel();
    currentModel.personalConfig = { properties: { contextWindow: 64_000 } };
    currentModel.config = {
      ...currentModel.config,
      properties: { ...currentModel.config.properties, contextWindow: 64_000 },
    };

    const result = resolveProviderModelDraftCommit({
      currentModel,
      draft: {
        ...createProviderModelDraftValues(currentModel),
        contextWindowValue: "",
      },
    });

    expect(result.status).toBe("commit");
    if (result.status !== "commit") return;
    expect(result.model.config.properties?.contextWindow).toBe(128_000);
    expect(result.model.personalConfig.properties?.contextWindow).toBeUndefined();
  });

  it("提交时更新可见字段并保留 reasoning 配置", () => {
    const result = resolveProviderModelDraftCommit({
      currentModel: createModel(),
      draft: {
        ...createProviderModelDraftValues(createModel()),
        idValue: "renamed-model",
        contextWindowValue: "200000",
        maxOutputTokensValue: "8000",
        inputFormatValue: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
      },
    });
    expect(result.status).toBe("commit");
    if (result.status !== "commit") return;
    expect(result.model.modelId).toBe("renamed-model");
    expect(result.model.hasPersonalConfig).toBe(true);
    expect(result.model.config.properties?.contextWindow).toBe(200_000);
    expect(result.model.config.optionSpecs?.maxOutputTokens).toEqual({
      max: 8_000,
      map: "{'max_completion_tokens': maxOutputTokens}",
    });
    expect(result.model.config.optionSpecs?.reasoningLevel?.map).toBe(
      "{'reasoning_effort': reasoningLevel}",
    );
    expect(result.model.config.optionSpecs?.maxOutputTokens?.map).toBe(
      "{'max_completion_tokens': maxOutputTokens}",
    );
  });

  it("最大输出直接编辑 max，放大和缩小均形成精确 Personal max", () => {
    const currentModel = createModel();
    currentModel.personalConfig = {
      optionSpecs: { maxOutputTokens: { max: 8_000 } },
    };
    currentModel.config = {
      ...currentModel.config,
      optionSpecs: {
        ...currentModel.config.optionSpecs,
        maxOutputTokens: { max: 8_000 },
      },
    };

    const unchanged = resolveProviderModelDraftCommit({
      currentModel,
      draft: createProviderModelDraftValues(currentModel),
    });
    expect(unchanged.status).toBe("commit");
    if (unchanged.status !== "commit") return;
    expect(unchanged.model.personalConfig.optionSpecs?.maxOutputTokens).toEqual({
      max: 8_000,
    });

    const expanded = resolveProviderModelDraftCommit({
      currentModel,
      draft: { ...createProviderModelDraftValues(currentModel), maxOutputTokensValue: "64000" },
    });
    expect(expanded.status).toBe("commit");
    if (expanded.status !== "commit") return;
    expect(expanded.model.personalConfig.optionSpecs?.maxOutputTokens).toEqual({
      max: 64_000,
    });

    const shrunk = resolveProviderModelDraftCommit({
      currentModel,
      draft: { ...createProviderModelDraftValues(currentModel), maxOutputTokensValue: "2000" },
    });
    expect(shrunk.status).toBe("commit");
    if (shrunk.status !== "commit") return;
    expect(shrunk.model.personalConfig.optionSpecs?.maxOutputTokens).toEqual({
      max: 2_000,
    });
  });

  it("显式填写与推荐相等的最大输出仍保留个人意图", () => {
    const currentModel = createModel();
    const result = resolveProviderModelDraftCommit({
      currentModel,
      draft: {
        ...createProviderModelDraftValues(currentModel),
        maxOutputTokensValue: "32000",
      },
    });

    expect(result.status).toBe("commit");
    if (result.status !== "commit") return;
    expect(result.model.personalConfig.optionSpecs?.maxOutputTokens).toEqual({ max: 32000 });
  });

  it("清空最大输出时删除 Personal Option Spec 并恢复继承值", () => {
    const currentModel = createModel();
    currentModel.personalConfig = {
      optionSpecs: { maxOutputTokens: { max: 8_000 } },
    };
    currentModel.config = {
      ...currentModel.config,
      optionSpecs: {
        ...currentModel.config.optionSpecs,
        maxOutputTokens: { max: 8_000 },
      },
    };

    const result = resolveProviderModelDraftCommit({
      currentModel,
      draft: { ...createProviderModelDraftValues(currentModel), maxOutputTokensValue: "" },
    });

    expect(result.status).toBe("commit");
    if (result.status !== "commit") return;
    expect(result.model.personalConfig.optionSpecs?.maxOutputTokens).toBeUndefined();
    expect(result.model.config.optionSpecs?.maxOutputTokens).toEqual({
      max: 32_000,
      map: "{'max_completion_tokens': maxOutputTokens}",
    });
  });

  it("编辑可见 Image/Video/PDF 时原样保留隐藏的 Audio 事实", () => {
    const currentModel = createModel();
    currentModel.config.properties = {
      ...currentModel.config.properties,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: true,
        supportsPdf: true,
      },
      outputFormat: { supportsText: true },
    };
    const draft = createProviderModelDraftValues(currentModel);
    const result = resolveProviderModelDraftCommit({
      currentModel,
      draft: {
        ...draft,
        inputFormatValue: {
          ...draft.inputFormatValue,
          supportsImage: true,
          supportsPdf: false,
        },
      },
    });

    expect(result.status).toBe("commit");
    if (result.status !== "commit") return;
    expect(result.model.config.properties?.inputFormat).toEqual({
      supportsText: true,
      supportsImage: true,
      supportsVideo: false,
      supportsAudio: true,
      supportsPdf: false,
    });
  });

  it("拒绝空模型 ID 和非正整数容量", () => {
    expect(
      resolveProviderModelDraftCommit({
        currentModel: createModel(),
        draft: {
          idValue: "",
          contextWindowValue: "128000",
          maxOutputTokensValue: "32000",
          inputFormatValue: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
        },
      }),
    ).toEqual({ status: "invalid", field: "id" });
    expect(
      resolveProviderModelDraftCommit({
        currentModel: createModel(),
        draft: {
          idValue: "demo-model",
          contextWindowValue: "0",
          maxOutputTokensValue: "32000",
          inputFormatValue: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
        },
      }),
    ).toEqual({ status: "invalid", field: "contextWindow" });
  });
});
