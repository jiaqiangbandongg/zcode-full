import { describe, expect, it, vi } from "vitest";
import {
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ModelSelectionFacade,
  ProviderConfigMap,
  ProviderRegistryService,
  ProviderSettingsFacade,
  type AccountProviderConfigSnapshot,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "../src/index.js";
import {
  createAccountProviderConfig,
  createApiKeyProviderConfig,
} from "./provider-config-fixtures.js";

class StaticSource<TSnapshot> implements ProviderSource<TSnapshot> {
  constructor(readonly snapshot: TSnapshot) {}

  async read(): Promise<TSnapshot> {
    return this.snapshot;
  }

  onDidChange(): () => void {
    return () => {};
  }
}

function completeModelConfig(): ModelConfig {
  return new ModelConfig({
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 200_000,
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
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: {
        max: 32_000,
        map: "{'max_tokens': maxOutputTokens}",
      },
    }),
    enabled: true,
  });
}

async function createService(): Promise<ProviderRegistryService> {
  const config: ProviderConfigSnapshot = {
    revision: "config-1",
    zcodeBuiltinRevision: "builtin-1",
    personalRevision: "personal-1",
    zcodeBuiltinProviders: new ProviderConfigMap([
      [
        "account",
        createAccountProviderConfig({
          apiFormat: "anthropic-messages",
          baseURL: "https://account.example.com",
          models: ["m1", "m2"],
        }),
      ],
      ["broken", createApiKeyProviderConfig({ models: ["m1"] })],
      [
        "hidden",
        createApiKeyProviderConfig({
          apiFormat: "anthropic-messages",
          baseURL: "https://hidden.example.com",
          apiKey: "hidden-key",
          models: ["m1"],
          visibility: "hidden",
        }),
      ],
    ]),
    personalProviders: new ProviderConfigMap([
      {
        providerId: "personal",
        providerName: "Personal API",
        config: createApiKeyProviderConfig({
          group: "standard-personal",
          apiFormat: "openai-responses",
          baseURL: "https://personal.example.com",
          apiKey: "test-key",
          personalModels: ["custom"],
        }),
      },
    ]),
    zcodeBuiltinModelRules: new ModelConfigRules([
      { type: "model", modelMatch: ".*", config: completeModelConfig() },
    ]),
    personalModels: new ModelConfigRules([
      {
        type: "manual-provider-model",
        providerId: "personal",
        modelId: "custom",
        config: completeModelConfig().overlay(
          new ModelConfig({
            properties: new ModelPropertiesConfig({ inputFormat: { supportsImage: true } }),
          }),
        ),
      },
      {
        type: "model",
        modelMatch: "custom",
        config: new ModelConfig({
          properties: new ModelPropertiesConfig({ inputFormat: { supportsImage: false } }),
        }),
      },
    ]),
  };
  const account: AccountProviderConfigSnapshot = {
    revision: "account-1",
    states: { account: { availability: "available", entitled: true, current: true } },
    basedOnZCodeBuiltinRevision: "builtin-1",
    providers: new ProviderConfigMap([
      ["account", createAccountProviderConfig({ models: ["m1"], entitled: true })],
    ]),
  };
  const service = new ProviderRegistryService({
    configSource: new StaticSource(config),
    accountSource: new StaticSource(account),
  });
  await service.start();
  return service;
}

describe("Provider Facades", () => {
  it("Settings View 同时投影 Personal、Effective、问题和调序能力", async () => {
    const service = await createService();
    const view = new ProviderSettingsFacade(service).getView();

    expect(view.providers.map((provider) => provider.providerId)).toEqual([
      "account",
      "broken",
      "personal",
    ]);
    expect(view.providers[0]).toMatchObject({
      providerId: "account",
      executable: true,
      effectiveBuiltinConfig: {
        access: { type: "zhipu-account" },
        api: {
          type: "anthropic-messages",
          baseUrl: "https://account.example.com",
        },
        builtinModelIds: ["m1"],
      },
      effectiveConfig: {
        access: { type: "zhipu-account" },
        api: {
          type: "anthropic-messages",
          baseUrl: "https://account.example.com",
        },
        builtinModelIds: ["m1"],
      },
    });
    expect(view.providers[1]?.issues.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining(["providers.broken.access.apiKey", "providers.broken.api"]),
    );
    expect(view.providers[2]).toMatchObject({
      providerId: "personal",
      executable: true,
      models: [
        {
          modelId: "custom",
          useRecommendedConfig: false,
          personalExactConfig: { properties: { inputFormat: { supportsImage: true } } },
          effectiveBuiltinConfig: {
            properties: { contextWindow: 200_000 },
          },
          effectiveConfig: {
            properties: { inputFormat: { supportsImage: true }, contextWindow: 200_000 },
          },
        },
      ],
    });
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it("Settings 模型配置解析复用 ZCodeBuiltin 与 Personal Model Config Rules", async () => {
    const service = await createService();
    const facade = new ProviderSettingsFacade(service);
    const current = facade.getView();

    expect(facade.resolveModelConfig({ providerId: "personal", modelId: "custom" })).toMatchObject({
      effectiveConfig: {
        properties: {
          contextWindow: 200_000,
          inputFormat: expect.objectContaining({ supportsImage: true }),
        },
      },
      issues: [],
    });

    expect(facade.getView()).toEqual(current);
  });

  it("Personal Model Draft 解析移动精确 Rule，但不修改正式 View", async () => {
    const service = await createService();
    const facade = new ProviderSettingsFacade(service);
    const current = facade.getView();

    const resolution = facade.resolveModelConfig({
      providerId: "personal",
      originalModelId: "custom",
      modelId: "renamed",
      personalConfig: { properties: { inputFormat: { supportsImage: true } } },
    });

    expect(resolution).toMatchObject({
      inheritedConfig: {
        properties: {
          contextWindow: 200_000,
          inputFormat: expect.objectContaining({ supportsImage: false }),
        },
      },
      effectiveConfig: {
        properties: {
          contextWindow: 200_000,
          inputFormat: expect.objectContaining({ supportsImage: true }),
        },
      },
      issues: [],
    });
    expect(facade.getView()).toEqual(current);
  });

  it("Personal Model Draft 保存校验 View revision 后只调用一次原子 Mutation", async () => {
    const service = await createService();
    const savePersonalModelDraft = vi.fn(async () => undefined);
    const mutations = {
      createPersonalProvider: vi.fn(async () => ({ providerId: "new-provider" })),
      savePersonalProviderOverlay: vi.fn(async () => undefined),
      deletePersonalProvider: vi.fn(async () => undefined),
      reorderPersonalProviders: vi.fn(async () => undefined),
      reorderPersonalModels: vi.fn(async () => undefined),
      addPersonalModel: vi.fn(async () => undefined),
      renamePersonalModel: vi.fn(async () => undefined),
      deletePersonalModel: vi.fn(async () => undefined),
      setPersonalModelEnabled: vi.fn(async () => undefined),
      savePersonalModelDraft,
      refresh: vi.fn(async () => service.getSnapshot()!),
    };
    const facade = new ProviderSettingsFacade(service, mutations);
    const revision = facade.getView().revision;

    await facade.savePersonalModelDraft({
      providerId: "personal",
      originalModelId: "custom",
      nextModelId: "renamed",
      personalConfig: { enabled: false },
      useRecommendedConfig: false,
      basedOnRevision: revision,
    });

    expect(savePersonalModelDraft).toHaveBeenCalledTimes(1);
    expect(savePersonalModelDraft).toHaveBeenCalledWith(
      "personal",
      "custom",
      "renamed",
      expect.objectContaining({ enabled: false }),
      expect.any(String),
      false,
      expect.objectContaining({
        providerId: "personal",
        inheritedModelIds: [],
        personalRevision: "personal-1",
      }),
    );
    expect(mutations.renamePersonalModel).not.toHaveBeenCalled();

    await expect(
      facade.savePersonalModelDraft({
        providerId: "personal",
        originalModelId: "custom",
        nextModelId: "stale",
        personalConfig: {},
        basedOnRevision: revision + 1,
      }),
    ).rejects.toThrow("revision conflict");
    expect(savePersonalModelDraft).toHaveBeenCalledTimes(1);
  });

  it("Settings Facade 可显式等待 Source 刷新后返回最新 View", async () => {
    const service = await createService();
    const refresh = vi.spyOn(service, "refresh");
    const facade = new ProviderSettingsFacade(service);

    const view = await facade.refresh("purchase-complete");

    expect(refresh).toHaveBeenCalledWith("purchase-complete");
    expect(view).toEqual(facade.getView());
  });

  it("Selection View 只投影 Registry 中实际可选的 Provider 和模型", async () => {
    const service = await createService();
    const facade = new ModelSelectionFacade(service);
    const view = facade.getView();

    expect(view.providers.map((provider) => provider.providerId)).toEqual(["account", "personal"]);
    expect(service.listProviders().map((provider) => provider.providerId)).toEqual([
      "account",
      "hidden",
      "personal",
    ]);
    expect(view.providers[1]?.models.map((model) => model.modelId)).toEqual(["custom"]);
    // 不能只在 UI mock 中补名称：真实 Registry → View 也必须投影规则层名称。
    expect(view.providers[1]?.providerName).toBe("Personal API");
    expect(view.providers[1]?.config).not.toHaveProperty("label");
  });

  it("消费者有效选择不进入共享 View，旧账号身份即使不在 Registry 也能对应", async () => {
    const service = await createService();
    const facade = new ModelSelectionFacade(service, (id) =>
      ["old-account", "account"].includes(id) ? "account-plan" : "ordinary",
    );
    const original = {
      providerId: "old-account",
      modelId: "m1",
      options: { reasoningLevel: "disabled" },
    };
    const view = facade.getView(undefined, undefined, { selection: original });
    expect(view.effectiveSelection).toEqual({ ...original, providerId: "account" });
    expect(view.selectionIssue).toBeUndefined();
    expect(facade.getView()).not.toHaveProperty("effectiveSelection");
    expect(facade.getView(undefined, undefined, { selection: null }).effectiveSelection).toBeNull();
    expect(
      facade.getView(undefined, undefined, { selection: original }).effectiveSelection,
    ).toEqual(view.effectiveSelection);
    expect(original.providerId).toBe("old-account");
  });

  it("Settings 写操作只接收可序列化配置，并在 Registry 刷新后返回同一份 View", async () => {
    const service = await createService();
    const mutations = {
      createPersonalProvider: vi.fn(async () => ({ providerId: "new-provider" })),
      savePersonalProviderOverlay: vi.fn(async () => undefined),
      deletePersonalProvider: vi.fn(async () => undefined),
      reorderPersonalProviders: vi.fn(async () => undefined),
      reorderPersonalModels: vi.fn(async () => undefined),
      addPersonalModel: vi.fn(async () => undefined),
      renamePersonalModel: vi.fn(async () => undefined),
      deletePersonalModel: vi.fn(async () => undefined),
      setPersonalModelEnabled: vi.fn(async () => undefined),
      savePersonalModelDraft: vi.fn(async () => undefined),
      refresh: vi.fn(async () => service.getSnapshot()!),
    };
    const facade = new ProviderSettingsFacade(service, mutations);

    const created = await facade.createPersonalProvider();
    const view = await facade.savePersonalProviderOverlay(
      "personal",
      {
        access: { type: "api-key", apiKey: "test-key" },
      },
      { providerName: "New Provider" },
    );
    await facade.reorderPersonalProviders(["personal", "new-provider"]);
    // Mutation 是只记录调用的 stub；成员操作使用真实快照中已有的 Provider。
    await facade.reorderPersonalModels("personal", ["custom"]);
    await facade.addPersonalModel("personal", "model.2", {
      properties: { contextWindow: 128_000 },
    });
    await facade.renamePersonalModel("personal", "custom", "model.2");
    await facade.deletePersonalModel("personal", "model.2");
    await facade.deletePersonalProvider("new-provider");

    expect(mutations.savePersonalProviderOverlay).toHaveBeenCalledWith(
      "personal",
      expect.objectContaining({
        access: expect.objectContaining({
          type: "api-key",
          apiKey: "test-key",
        }),
      }),
      expect.objectContaining({ providerId: "personal", assertCurrent: expect.any(Function) }),
      { providerName: "New Provider" },
    );
    expect(created).toEqual({ providerId: "new-provider", view });
    expect(mutations.addPersonalModel).toHaveBeenCalledWith(
      "personal",
      "model.2",
      expect.objectContaining({
        properties: expect.objectContaining({ contextWindow: 128_000 }),
      }),
      expect.objectContaining({ providerId: "personal", inheritedModelIds: [] }),
      undefined,
    );
    expect(mutations.deletePersonalProvider).toHaveBeenCalledWith("new-provider");
    expect(mutations.renamePersonalModel).toHaveBeenCalledWith(
      "personal",
      "custom",
      "model.2",
      expect.objectContaining({ providerId: "personal" }),
    );
    expect(mutations.deletePersonalModel).toHaveBeenCalledWith(
      "personal",
      "model.2",
      expect.objectContaining({ providerId: "personal" }),
    );
    expect(mutations.refresh).toHaveBeenCalledTimes(8);
    expect(view).toEqual(new ProviderSettingsFacade(service).getView());
    await expect(
      facade.savePersonalProviderOverlay("bad", {
        kind: "api",
        baseURL: "not-a-url",
      }),
    ).rejects.toThrow();
  });

  it("同一 Provider 写入保持串行", async () => {
    const service = await createService();
    const calls: string[] = [];
    let releaseSave!: () => void;
    const mutations = {
      createPersonalProvider: vi.fn(async () => ({ providerId: "new-provider" })),
      savePersonalProviderOverlay: vi.fn(async () => {
        calls.push("save:start");
        await new Promise<void>((resolve) => (releaseSave = resolve));
        calls.push("save:end");
      }),
      deletePersonalProvider: vi.fn(async () => undefined),
      reorderPersonalProviders: vi.fn(async () => undefined),
      reorderPersonalModels: vi.fn(async () => undefined),
      addPersonalModel: vi.fn(async () => undefined),
      renamePersonalModel: vi.fn(async () => undefined),
      deletePersonalModel: vi.fn(async () => undefined),
      setPersonalModelEnabled: vi.fn(async () => undefined),
      savePersonalModelDraft: vi.fn(async () => calls.push("model")),
      refresh: vi.fn(async () => service.getSnapshot()!),
    };
    const facade = new ProviderSettingsFacade(service, mutations);
    const save = facade.savePersonalProviderOverlay("personal", {}, { providerName: "changed" });
    const model = facade.savePersonalModelDraft({
      providerId: "personal",
      originalModelId: "custom",
      nextModelId: "custom",
      personalConfig: { enabled: false },
      basedOnRevision: facade.getView().revision,
    });

    await vi.waitFor(() => expect(calls).toEqual(["save:start"]));
    releaseSave();
    await Promise.all([save, model]);
    expect(calls).toEqual(["save:start", "save:end", "model"]);
  });

  it("delete 失败后解除终止标记，允许用户修正并重试保存", async () => {
    const service = await createService();
    const mutations = {
      createPersonalProvider: vi.fn(async () => ({ providerId: "new-provider" })),
      savePersonalProviderOverlay: vi.fn(async () => undefined),
      deletePersonalProvider: vi.fn(async () => {
        throw new Error("delete failed");
      }),
      reorderPersonalProviders: vi.fn(async () => undefined),
      reorderPersonalModels: vi.fn(async () => undefined),
      addPersonalModel: vi.fn(async () => undefined),
      renamePersonalModel: vi.fn(async () => undefined),
      deletePersonalModel: vi.fn(async () => undefined),
      setPersonalModelEnabled: vi.fn(async () => undefined),
      savePersonalModelDraft: vi.fn(async () => undefined),
      refresh: vi.fn(async () => service.getSnapshot()!),
    };
    const facade = new ProviderSettingsFacade(service, mutations);

    await expect(facade.deletePersonalProvider("personal")).rejects.toThrow("delete failed");
    await facade.savePersonalProviderOverlay("personal", {}, { providerName: "retry" });

    expect(mutations.savePersonalProviderOverlay).toHaveBeenCalledTimes(1);
  });

  it("删除等待同一 Provider 已经开始的保存，最终删除最后执行", async () => {
    const service = await createService();
    const calls: string[] = [];
    let releaseSave!: () => void;
    const mutations = {
      createPersonalProvider: vi.fn(async () => ({ providerId: "new-provider" })),
      savePersonalProviderOverlay: vi.fn(async () => {
        calls.push("save:start");
        await new Promise<void>((resolve) => (releaseSave = resolve));
        calls.push("save:end");
      }),
      deletePersonalProvider: vi.fn(async () => calls.push("delete")),
      reorderPersonalProviders: vi.fn(async () => undefined),
      reorderPersonalModels: vi.fn(async () => undefined),
      addPersonalModel: vi.fn(async () => undefined),
      renamePersonalModel: vi.fn(async () => undefined),
      deletePersonalModel: vi.fn(async () => undefined),
      setPersonalModelEnabled: vi.fn(async () => undefined),
      savePersonalModelDraft: vi.fn(async () => undefined),
      refresh: vi.fn(async () => service.getSnapshot()!),
    };
    const facade = new ProviderSettingsFacade(service, mutations);

    const save = facade.savePersonalProviderOverlay("personal", {}, { providerName: "changed" });
    const deletion = facade.deletePersonalProvider("personal");
    await vi.waitFor(() => expect(calls).toEqual(["save:start"]));
    releaseSave();
    await Promise.all([save, deletion]);

    expect(calls).toEqual(["save:start", "save:end", "delete"]);
  });
});
