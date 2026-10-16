import { describe, expect, it, vi } from "vitest";
import {
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigService,
  ProviderRegistryService,
  ProviderSettingsFacade,
  ProviderTemplate,
  ProviderTemplateMap,
  extractManualModelConfig,
  type AccountProviderConfigSnapshot,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
  type ProviderSource,
} from "../src/index.js";
import {
  createAccountProviderConfig,
  createApiKeyProviderConfig,
} from "./provider-config-fixtures.js";

class MutableSource<TSnapshot> implements ProviderSource<TSnapshot> {
  readonly #listeners = new Set<(reason: string) => void>();

  constructor(public current: TSnapshot) {}

  async read(): Promise<TSnapshot> {
    return this.current;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(reason: string): void {
    for (const listener of this.#listeners) listener(reason);
  }
}

class MemoryPersonalRepository
  extends MutableSource<ProviderConfigLayerSnapshot>
  implements PersonalProviderConfigRepository
{
  revision = 1;

  async update(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot> {
    const next = transform(this.current);
    this.revision += 1;
    this.current = {
      revision: `personal-${this.revision}`,
      providers: next.providers,
      models: next.models,
      providerOrder: next.providerOrder,
    };
    this.emit("updated");
    return this.current;
  }
}

function layerSnapshot(
  revision: string,
  providers = ProviderConfigMap.empty(),
  models = ModelConfigRules.empty(),
  providerOrder: readonly string[] = [],
): ProviderConfigLayerSnapshot {
  return { revision, providers, models, providerOrder };
}

function localProvider(modelIds: readonly string[]): ProviderConfig {
  return createApiKeyProviderConfig({
    apiFormat: "anthropic-messages",
    baseURL: "https://api.example.com",
    apiKey: "test-key",
    models: modelIds,
  });
}

function personalProvider(modelIds: readonly string[]): ProviderConfig {
  return createApiKeyProviderConfig({
    group: "standard-personal",
    apiFormat: "anthropic-messages",
    baseURL: "https://api.example.com",
    apiKey: "test-key",
    personalModels: modelIds,
  });
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

function manualModelConfig(): ModelConfig {
  return ModelConfig.fromData(extractManualModelConfig(completeModelConfig().toJSON()));
}

describe("ProviderConfigService", () => {
  it.each(["zai", "bigmodel"] as const)(
    "%s 账号所有模式拒绝新禁用，旧禁用不阻断普通保存",
    async (accountType) => {
      for (const mode of [
        "start-plan",
        "individual-coding-plan",
        "team-coding-plan",
        "off-peak",
      ] as const) {
        const personal = new MemoryPersonalRepository(
          layerSnapshot(
            "personal-1",
            new ProviderConfigMap([
              { providerId: "account", enabled: false, config: new ProviderConfig({}) },
            ]),
          ),
        );
        const service = new ProviderConfigService({
          zcodeBuiltinSource: new MutableSource(
            layerSnapshot(
              "builtin-1",
              new ProviderConfigMap([
                ["account", createAccountProviderConfig({ accountType, mode })],
              ]),
            ),
          ),
          personalRepository: personal,
        });
        try {
          const before = personal.current;
          await expect(
            service.savePersonalProviderOverlay("account", new ProviderConfig({}), undefined, {
              enabled: false,
            }),
          ).rejects.toThrow(/Account Provider.*禁用/);
          expect(personal.current).toBe(before);
          await service.savePersonalProviderOverlay("account", new ProviderConfig({}), undefined, {
            providerName: "renamed",
          });
          expect(personal.current.providers.getRule("account")?.providerName).toBe("renamed");
        } finally {
          service.dispose();
        }
      }
    },
  );
  it("Provider 外层启停经过保存和成员操作仍保留，不修改配置内容", async () => {
    const original = personalProvider(["A"]);
    const personal = new MemoryPersonalRepository(
      layerSnapshot("personal-1", new ProviderConfigMap([["p", original]])),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("builtin-1")),
      personalRepository: personal,
    });
    try {
      await service.savePersonalProviderOverlay("p", original, undefined, { enabled: false });
      expect(personal.current.providers.getRule("p")?.enabled).toBe(false);
      expect(personal.current.providers.get("p")?.toJSON()).toEqual(original.toJSON());
      await service.addPersonalModel("p", "B", completeModelConfig());
      await service.reorderPersonalModels("p", ["B", "A"]);
      await service.savePersonalProviderOverlay(
        "p",
        personal.current.providers.get("p")!,
        undefined,
        { providerName: "renamed" },
      );
      expect(personal.current.providers.getRule("p")?.enabled).toBe(false);
      await service.savePersonalProviderOverlay(
        "p",
        personal.current.providers.get("p")!,
        undefined,
        { enabled: true },
      );
      expect(personal.current.providers.getRule("p")?.enabled).toBe(true);
    } finally {
      service.dispose();
    }
  });
  it("Todo90：添加固定配置同时保存模式；不完整时不得留下成员", async () => {
    const builtin = new MutableSource(layerSnapshot("builtin-1"));
    const personal = new MemoryPersonalRepository(
      layerSnapshot("personal-1", new ProviderConfigMap([["p", personalProvider([])]])),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: builtin,
      personalRepository: personal,
    });
    try {
      await expect(
        service.addPersonalModel("p", "bad", new ModelConfig({}), undefined, false),
      ).rejects.toThrow(/properties|optionSpecs|contextWindow/);
      expect(personal.current.providers.get("p")?.personalModelIds).toEqual([]);
      await service.addPersonalModel("p", "good", manualModelConfig(), undefined, false);
      expect(personal.current.models.getExactRule("p", "good")?.type).toBe("manual-provider-model");
      expect(personal.current.providers.get("p")?.personalModelIds).toEqual(["good"]);
    } finally {
      service.dispose();
    }
  });
  it("Todo89：直接写入也保护继承成员；新继承成员在已有顺序之前", async () => {
    const builtin = new MutableSource(
      layerSnapshot("builtin-1", new ProviderConfigMap([["p", localProvider(["NEW", "A"])]])),
    );
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          ["p", new ProviderConfig({ personalModelIds: ["A", "B"], modelOrder: ["B", "A"] })],
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: builtin,
      personalRepository: personal,
    });
    try {
      await expect(service.renamePersonalModel("p", "A", "renamed")).rejects.toThrow(
        "Built-in Model",
      );
      await expect(service.deletePersonalModel("p", "A")).rejects.toThrow("Built-in Model");
      await service.addPersonalModel("p", "C", new ModelConfig({}));
      expect(personal.current.providers.get("p")?.modelOrder).toEqual(["NEW", "B", "A", "C"]);
    } finally {
      service.dispose();
    }
  });
  it("Todo89：首次添加无需 Personal 根记录，保留排序且不复制继承成员", async () => {
    const builtin = new MutableSource(
      layerSnapshot("builtin-1", new ProviderConfigMap([["account", localProvider(["A", "B"])]])),
    );
    const personal = new MemoryPersonalRepository(layerSnapshot("personal-1"));
    const service = new ProviderConfigService({
      zcodeBuiltinSource: builtin,
      personalRepository: personal,
    });
    try {
      await service.addPersonalModel("account", "C", new ModelConfig({}));
      expect(personal.current.providers.get("account")?.toJSON()).toEqual({
        personalModelIds: ["C"],
        modelOrder: ["A", "B", "C"],
      });
      await service.reorderPersonalModels("account", ["B", "C", "A"]);
      await service.addPersonalModel("account", "D", new ModelConfig({}));
      expect(personal.current.providers.get("account")?.modelOrder).toEqual(["B", "C", "A", "D"]);
      expect(personal.current.models.getExact("account", "D")?.enabled).toBe(true);
      const before = personal.current;
      await expect(service.addPersonalModel("account", "A", new ModelConfig({}))).rejects.toThrow(
        "Model 已存在",
      );
      await expect(service.addPersonalModel("deleted", "A", new ModelConfig({}))).rejects.toThrow(
        "Provider",
      );
      expect(personal.current).toBe(before);
    } finally {
      service.dispose();
    }
  });

  it("Todo89：自定义供应商添加保留顺序；启停只更新最新 enabled，保留固定模式", async () => {
    const builtin = new MutableSource(layerSnapshot("builtin-1"));
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          ["custom", personalProvider(["A", "B"]).withModelOrder(["B", "A"])],
        ]),
        ModelConfigRules.empty().setExact(
          "custom",
          "A",
          manualModelConfig().overlay(
            new ModelConfig({
              properties: new ModelPropertiesConfig({ supportsNativeWebSearch: true }),
            }),
          ),
          false,
        ),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: builtin,
      personalRepository: personal,
    });
    try {
      await service.addPersonalModel("custom", "C", new ModelConfig({}));
      expect(personal.current.providers.get("custom")?.modelOrder).toEqual(["B", "A", "C"]);
      await service.setPersonalModelEnabled("custom", "A", false);
      expect(personal.current.models.getExact("custom", "A")?.toJSON()).toEqual(
        manualModelConfig()
          .overlay(
            new ModelConfig({
              enabled: false,
              properties: new ModelPropertiesConfig({ supportsNativeWebSearch: true }),
            }),
          )
          .toJSON(),
      );
      expect(personal.current.models.getExactRule("custom", "A")?.type).toBe(
        "manual-provider-model",
      );
      await expect(service.setPersonalModelEnabled("custom", "missing", true)).rejects.toThrow(
        "Model 不存在",
      );
    } finally {
      service.dispose();
    }
  });

  it("动态账号成员的展示、编辑、排序共用快照，不复制成员且不允许重命名", async () => {
    const builtin = new MutableSource(
      layerSnapshot(
        "builtin-1",
        new ProviderConfigMap([
          [
            "account",
            createAccountProviderConfig({
              apiFormat: "anthropic-messages",
              baseURL: "https://example.com",
              models: ["STATIC"],
            }),
          ],
        ]),
        new ModelConfigRules([{ type: "model", modelMatch: ".*", config: completeModelConfig() }]),
      ),
    );
    const personal = new MemoryPersonalRepository(layerSnapshot("personal-1"));
    const service = new ProviderConfigService({
      zcodeBuiltinSource: builtin,
      personalRepository: personal,
    });
    const account = new MutableSource<AccountProviderConfigSnapshot>({
      revision: "account-1",
      basedOnZCodeBuiltinRevision: "builtin-1",
      providers: new ProviderConfigMap([
        [
          "account",
          createAccountProviderConfig({ models: ["glm-new", "glm-next"], entitled: true }),
        ],
      ]),
    });
    const registry = new ProviderRegistryService({ configSource: service, accountSource: account });
    await registry.start();
    const facade = new ProviderSettingsFacade(registry, {
      createPersonalProvider: service.createPersonalProvider.bind(service),
      savePersonalProviderOverlay: service.savePersonalProviderOverlay.bind(service),
      deletePersonalProvider: service.deletePersonalProvider.bind(service),
      reorderPersonalProviders: service.reorderPersonalProviders.bind(service),
      reorderPersonalModels: service.reorderPersonalModels.bind(service),
      addPersonalModel: service.addPersonalModel.bind(service),
      renamePersonalModel: service.renamePersonalModel.bind(service),
      deletePersonalModel: service.deletePersonalModel.bind(service),
      savePersonalModelDraft: service.savePersonalModelDraft.bind(service),
      setPersonalModelEnabled: service.setPersonalModelEnabled.bind(service),
      refresh: registry.refresh.bind(registry),
    });
    try {
      // 启停/编辑动态成员不创建根覆盖；随后仍必须能够首次添加个人模型。
      await facade.setPersonalModelEnabled("account", "glm-new", false);
      expect(personal.current.providers.has("account")).toBe(false);
      await facade.addPersonalModel("account", "personal-first", {});
      expect(personal.current.providers.get("account")?.personalModelIds).toEqual([
        "personal-first",
      ]);
      await facade.deletePersonalModel("account", "personal-first");
      await facade.savePersonalModelDraft({
        providerId: "account",
        originalModelId: "glm-new",
        nextModelId: "glm-new",
        personalConfig: { enabled: false },
        basedOnRevision: facade.getView().revision,
      });
      await facade.reorderPersonalModels("account", ["glm-next", "glm-new"]);
      // 模拟磁盘上遗留的账号禁用：设置投影和真实 Registry 必须读取同一公共结果。
      await personal.update((current) => ({
        ...current,
        providers: current.providers.setRule({
          ...current.providers.getRule("account")!,
          enabled: false,
        }),
      }));
      await registry.refresh();
      const view = facade
        .getView()
        .providers.find((provider) => provider.providerId === "account")!;
      expect(view.models.map((model) => model.modelId)).toEqual(["glm-next", "glm-new"]);
      expect(view.enabled).toBe(true);
      expect(view.executable).toBe(true);
      expect(view.models.find((model) => model.modelId === "glm-new")?.enabled).toBe(false);
      expect(personal.current.providers.get("account")?.personalModelIds).toEqual([]);
      expect(personal.current.providers.get("account")?.builtinModelIds).toBeUndefined();
      await facade.savePersonalProviderOverlay("account", {}, { providerName: "Account label" });
      expect(
        facade
          .getView()
          .providers.find((provider) => provider.providerId === "account")
          ?.models.map((model) => model.modelId),
      ).toEqual(["glm-next", "glm-new"]);
      expect(personal.current.providers.get("account")?.modelOrder).toEqual([
        "glm-next",
        "glm-new",
      ]);
      await expect(
        facade.savePersonalModelDraft({
          providerId: "account",
          originalModelId: "glm-new",
          nextModelId: "renamed",
          personalConfig: {},
          basedOnRevision: facade.getView().revision,
        }),
      ).rejects.toThrow("不能重命名");
      await expect(facade.addPersonalModel("account", "glm-next", {})).rejects.toThrow(
        "Model 已存在",
      );
      await Promise.all([
        facade.savePersonalModelDraft({
          providerId: "account",
          originalModelId: "glm-new",
          nextModelId: "glm-new",
          personalConfig: { properties: { requiresMfjsToolSchema: true }, enabled: false },
          basedOnRevision: facade.getView().revision,
        }),
        facade.setPersonalModelEnabled("account", "glm-new", true),
      ]);
      expect(personal.current.models.getExact("account", "glm-new")?.toJSON()).toEqual({
        properties: { requiresMfjsToolSchema: true },
        enabled: true,
      });
      const beforeToggleRevision = facade.getView().revision;
      const toggled = facade.setPersonalModelEnabled("account", "glm-new", false);
      const staleDraft = facade.savePersonalModelDraft({
        providerId: "account",
        originalModelId: "glm-new",
        nextModelId: "glm-new",
        personalConfig: {},
        basedOnRevision: beforeToggleRevision,
      });
      await Promise.all([toggled, expect(staleDraft).rejects.toThrow("revision conflict")]);
      expect(personal.current.models.getExact("account", "glm-new")?.toJSON()).toEqual({
        properties: { requiresMfjsToolSchema: true },
        enabled: false,
      });
      const oldRevision = facade.getView().revision;
      const beforeWrite = personal.current;
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const update = personal.update.bind(personal);
      vi.spyOn(personal, "update").mockImplementationOnce(async (transform) => {
        entered();
        await gate;
        return update(transform);
      });
      const queuedSave = facade.reorderPersonalModels("account", ["glm-new", "glm-next"]);
      const rejectedSave = expect(queuedSave).rejects.toThrow("revision conflict");
      await waiting;
      account.current = {
        ...account.current,
        revision: "account-2",
        providers: new ProviderConfigMap([
          ["account", createAccountProviderConfig({ models: [], entitled: true })],
        ]),
      };
      await registry.refresh("removed-members");
      release();
      await rejectedSave;
      expect(personal.current).toBe(beforeWrite);
      await expect(
        facade.savePersonalModelDraft({
          providerId: "account",
          originalModelId: "glm-new",
          nextModelId: "glm-new",
          personalConfig: {},
          basedOnRevision: oldRevision,
        }),
      ).rejects.toThrow("revision conflict");
      await expect(
        facade.savePersonalModelDraft({
          providerId: "account",
          originalModelId: "glm-new",
          nextModelId: "glm-new",
          personalConfig: {},
          basedOnRevision: facade.getView().revision,
        }),
      ).rejects.toThrow("Model 不存在");
    } finally {
      registry.dispose();
      service.dispose();
    }
  });

  it("把 ZCode Built-in Source 与 Personal Repository 聚合成 Registry Config Source", async () => {
    const zcodeBuiltin = new MutableSource(
      layerSnapshot(
        "zcodeBuiltin-1",
        new ProviderConfigMap([["zcodeBuiltin", localProvider(["model-a"])]]),
      ),
    );
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["personal", personalProvider(["model-b"])]]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });

    const snapshot = await service.read();

    expect(snapshot.revision).toBe('["zcodeBuiltin-1","personal-1"]');
    expect(snapshot.zcodeBuiltinRevision).toBe("zcodeBuiltin-1");
    expect(snapshot.personalRevision).toBe("personal-1");
    expect(snapshot.zcodeBuiltinProviders.keys()).toEqual(["zcodeBuiltin"]);
    expect(snapshot.personalProviders.keys()).toEqual(["personal"]);
  });

  it("Personal 保存、删除和调序都通过 Repository 的原子 update", async () => {
    const zcodeBuiltin = new MutableSource(layerSnapshot("zcodeBuiltin-1"));
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          ["Y", personalProvider(["m1", "m2"])],
          ["A", createApiKeyProviderConfig({ group: "standard-personal" })],
          ["X", personalProvider(["m3"])],
          ["Z", personalProvider(["m4"])],
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });

    await service.savePersonalProviderOverlay("Z", personalProvider(["m4"]));
    await service.reorderPersonalProviders(["A", "X", "Y", "Z"]);
    await service.reorderPersonalModels("Y", ["m2", "m1"]);
    await service.deletePersonalProvider("X");

    expect(personal.current.providers.keys()).toEqual(["Y", "A", "Z"]);
    expect(personal.current.providerOrder).toEqual(["A", "Y", "Z"]);
    expect(personal.current.providers.get("Y")?.personalModelIds).toEqual(["m1", "m2"]);
    expect(personal.current.providers.get("Y")?.modelOrder).toEqual(["m2", "m1"]);
  });

  it("Built-in Provider 首次调序时创建只包含 modelOrder 的 Personal Overlay", async () => {
    const zcodeBuiltin = new MutableSource(
      layerSnapshot(
        "zcodeBuiltin-1",
        new ProviderConfigMap([["builtin", localProvider(["model-a", "model-b"])]]),
      ),
    );
    const personal = new MemoryPersonalRepository(layerSnapshot("personal-1"));
    const service = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });

    await service.reorderPersonalModels("builtin", ["model-b", "model-a"]);

    expect(personal.current.providers.get("builtin")?.toJSON()).toEqual({
      modelOrder: ["model-b", "model-a"],
    });
  });

  it("普通 Provider 保存忽略陈旧成员字段，并保留 Repository 当前成员", async () => {
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["personal", personalProvider(["current-model"])]]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await service.savePersonalProviderOverlay(
      "personal",
      createApiKeyProviderConfig({
        group: "standard-personal",
        apiKey: "new-key",
        personalModels: ["stale-model"],
      }),
    );

    expect(personal.current.providers.get("personal")?.personalModelIds).toEqual(["current-model"]);
    expect(personal.current.providers.get("personal")?.access?.toJSON()).toMatchObject({
      type: "api-key",
      apiKey: "new-key",
    });
  });

  it("保存 Built-in Overlay 时规范化 Personal 重复成员并保留 Built-in 身份", async () => {
    const zcodeBuiltinProvider = localProvider(["builtin-model"]);
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          [
            "builtin",
            createApiKeyProviderConfig({
              group: null,
              personalModels: ["builtin-model", "personal-model", "personal-model"],
            }),
          ],
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(
        layerSnapshot("zcodeBuiltin-1", new ProviderConfigMap([["builtin", zcodeBuiltinProvider]])),
      ),
      personalRepository: personal,
    });

    await service.savePersonalProviderOverlay(
      "builtin",
      createApiKeyProviderConfig({ group: null, apiKey: "new-key" }),
    );

    expect(personal.current.providers.get("builtin")?.personalModelIds).toEqual(["personal-model"]);
  });

  it("Personal-only Provider 必须先显式创建，普通保存不能凭空创建", async () => {
    const personal = new MemoryPersonalRepository(layerSnapshot("personal-1"));
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await expect(
      service.savePersonalProviderOverlay(
        "personal",
        createApiKeyProviderConfig({ group: "standard-personal", apiKey: "late-key" }),
      ),
    ).rejects.toThrow("尚未创建");
    expect(personal.current.providers.has("personal")).toBe(false);
  });

  it("固定 Account Provider 的 Personal Overlay 不能改写 Access", async () => {
    const zcodeBuiltin = new MutableSource(
      layerSnapshot(
        "zcodeBuiltin-1",
        new ProviderConfigMap([
          {
            providerId: "account:bigmodel-individual-coding-plan",
            providerName: "BigModel",
            config: createAccountProviderConfig({
              accountType: "bigmodel",
              mode: "individual-coding-plan",
            }),
          },
        ]),
      ),
    );
    const personal = new MemoryPersonalRepository(layerSnapshot("personal-1"));
    const service = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });

    await expect(
      service.savePersonalProviderOverlay(
        "account:bigmodel-individual-coding-plan",
        createApiKeyProviderConfig({ group: null, apiKey: "family-key" }),
      ),
    ).rejects.toThrow("固定 Account Provider 的 Access");
    expect(personal.current.providers.has("account:bigmodel-individual-coding-plan")).toBe(false);
  });

  it("Provider label trim 后按大小写不敏感保持唯一", async () => {
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          {
            providerId: "one",
            providerName: "Demo",
            config: createApiKeyProviderConfig({ group: "standard-personal" }),
          },
          {
            providerId: "two",
            providerName: "Other",
            config: createApiKeyProviderConfig({ group: "standard-personal" }),
          },
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await expect(
      service.savePersonalProviderOverlay(
        "two",
        createApiKeyProviderConfig({ group: "standard-personal" }),
        undefined,
        { providerName: "  dEMo  " },
      ),
    ).rejects.toThrow("Provider 名称已存在");
  });

  it("历史重名不阻断未引入新重名的 Provider 保存", async () => {
    const zcodeBuiltin = new MutableSource(
      layerSnapshot(
        "zcodeBuiltin-1",
        new ProviderConfigMap([
          {
            providerId: "deepseek",
            providerName: "DeepSeek",
            config: createApiKeyProviderConfig({ group: "standard-personal", apiKey: "" }),
          },
        ]),
      ),
    );
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          {
            providerId: "legacy-one",
            providerName: "Legacy",
            config: createApiKeyProviderConfig({ group: "standard-personal" }),
          },
          {
            providerId: "legacy-two",
            providerName: "Legacy",
            config: createApiKeyProviderConfig({ group: "standard-personal" }),
          },
          ["deepseek", new ProviderConfig()],
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });

    await expect(
      service.savePersonalProviderOverlay(
        "deepseek",
        createApiKeyProviderConfig({
          group: "standard-personal",
          label: "DeepSeek",
          apiKey: "new-key",
        }),
      ),
    ).resolves.toBeDefined();
    expect(personal.current.providers.get("deepseek")?.access?.toJSON()).toMatchObject({
      apiKey: "new-key",
    });
  });

  it("原子创建下一个未占用的 Personal Provider 身份", async () => {
    const zcodeBuiltin = new MutableSource(
      layerSnapshot(
        "zcodeBuiltin-1",
        new ProviderConfigMap([["new-provider-2", localProvider(["zcodeBuiltin-model"])]]),
      ),
    );
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["new-provider", personalProvider(["personal-model"])]]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });

    const created = await service.createPersonalProvider();

    expect(created.providerId).toBe("new-provider-3");
    expect(personal.current.providers.getRule(created.providerId)?.providerName).toBe(
      "new-provider",
    );
    expect(personal.current.providers.keys()).toEqual(["new-provider", "new-provider-3"]);
    expect(personal.current.providers.get("new-provider-3")?.toJSON()).toEqual({
      group: "standard-personal",
      access: { type: "api-key" },
      personalModelIds: [],
      modelOrder: [],
    });
    expect(personal.current.providerOrder).toEqual(["new-provider", "new-provider-3"]);
  });

  it("使用调用方提供的 Template 名称种子并在原子创建中去重", async () => {
    const template = new ProviderTemplate({
      templateId: "deepseek",
      templateNameMap: { "zh-CN": "深度求索", "en-US": "DeepSeek" },
      config: createApiKeyProviderConfig({
        label: "DeepSeek",
        apiFormat: "anthropic-messages",
        baseURL: "https://api.example.com",
        models: ["model-a"],
      }),
    });
    const zcodeBuiltin = new MutableSource({
      ...layerSnapshot("zcodeBuiltin-1"),
      providerTemplates: new ProviderTemplateMap([["deepseek", template]]),
    });
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          {
            providerId: "existing",
            providerName: "深度求索",
            config: new ProviderConfig({ group: "standard-personal" }),
          },
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });

    const created = await service.createPersonalProvider({
      templateId: "deepseek",
      locale: "zh-CN",
    });

    expect(personal.current.providers.getRule(created.providerId)).toMatchObject({
      templateId: "deepseek",
      providerName: "深度求索 2",
    });
    await expect(
      service.createPersonalProvider({
        templateId: "deepseek",
        providerName: "DeepSeek",
        initialConfig: new ProviderConfig({ group: "zai-family" }),
      }),
    ).rejects.toThrow();
  });

  it("并发创建同一 Template 时仍生成唯一名称", async () => {
    const template = new ProviderTemplate({
      templateId: "deepseek",
      templateNameMap: { "zh-CN": "深度求索", "en-US": "DeepSeek" },
      config: createApiKeyProviderConfig({
        label: "DeepSeek",
        apiFormat: "anthropic-messages",
        baseURL: "https://api.example.com",
        models: ["model-a"],
      }),
    });
    const personal = new MemoryPersonalRepository(layerSnapshot("personal-1"));
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource({
        ...layerSnapshot("zcodeBuiltin-1"),
        providerTemplates: new ProviderTemplateMap([["deepseek", template]]),
      }),
      personalRepository: personal,
    });

    await Promise.all([
      service.createPersonalProvider({ templateId: "deepseek", locale: "zh-CN" }),
      service.createPersonalProvider({ templateId: "deepseek", locale: "zh-CN" }),
    ]);

    expect(
      personal.current.providers
        .rules()
        .map((rule) => rule.providerName)
        .sort(),
    ).toEqual(["深度求索", "深度求索 2"]);
  });

  it("写入 Provider 顺序使用未排序 Built-in、请求顺序、未排序 Personal 三段语义", async () => {
    const zcodeBuiltin = new MutableSource(
      layerSnapshot(
        "zcodeBuiltin-1",
        new ProviderConfigMap([
          ["builtin-a", localProvider(["model-a"])],
          ["builtin-b", localProvider(["model-b"])],
        ]),
      ),
    );
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          ["personal-p", personalProvider(["model-p"])],
          ["personal-q", personalProvider(["model-q"])],
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });

    await service.reorderPersonalProviders(["personal-p", "builtin-b", "stale", "personal-p"]);

    expect(personal.current.providerOrder).toEqual(["personal-p", "personal-q"]);
  });

  it("删除 Personal-only Provider 时同步清理精确模型规则", async () => {
    const exact = completeModelConfig();
    const pattern = new ModelConfig({
      properties: new ModelPropertiesConfig({ inputFormat: { supportsImage: true } }),
    });
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["personal", personalProvider(["model-a"])]]),
        new ModelConfigRules([
          {
            type: "provider-model",
            providerId: "personal",
            modelId: "model-a",
            config: exact,
          },
          {
            type: "model",
            modelMatch: "model-.*",
            config: pattern,
          },
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await service.deletePersonalProvider("personal", true);

    expect(personal.current.providers.get("personal")).toBeUndefined();
    expect(personal.current.models.rules()).toEqual([
      {
        type: "model",
        modelMatch: "model-.*",
        config: pattern,
      },
    ]);
  });

  it("原子重命名 Personal Model 并保持列表位置和精确配置", async () => {
    const modelConfig = completeModelConfig();
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["personal", personalProvider(["before", "old-model", "after"])]]),
        ModelConfigRules.empty().setExact("personal", "old-model", modelConfig),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await service.renamePersonalModel("personal", "old-model", "new-model");

    expect(personal.current.providers.get("personal")?.personalModelIds).toEqual([
      "before",
      "new-model",
      "after",
    ]);
    expect(personal.current.models.getExact("personal", "old-model")).toBeUndefined();
    expect(personal.current.models.getExact("personal", "new-model")).toEqual(modelConfig);
    expect(personal.current.providers.get("personal")?.modelOrder).toEqual([
      "before",
      "new-model",
      "after",
    ]);
  });

  it("一次事务同时重命名 Personal Model 并替换精确配置", async () => {
    const oldConfig = new ModelConfig({ enabled: false });
    const nextConfig = manualModelConfig().overlay(
      new ModelConfig({
        properties: new ModelPropertiesConfig({ contextWindow: 256_000 }),
      }),
    );
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["personal", personalProvider(["before", "old", "after"])]]),
        ModelConfigRules.empty().setExact("personal", "old", oldConfig),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });
    const update = vi.spyOn(personal, "update");

    await service.savePersonalModelDraft(
      "personal",
      "old",
      "next",
      nextConfig,
      "personal-1",
      false,
    );

    expect(update).toHaveBeenCalledTimes(1);
    expect(personal.current.providers.get("personal")?.personalModelIds).toEqual([
      "before",
      "next",
      "after",
    ]);
    expect(personal.current.providers.get("personal")?.modelOrder).toEqual([
      "before",
      "next",
      "after",
    ]);
    expect(personal.current.models.getExact("personal", "old")).toBeUndefined();
    expect(personal.current.models.getExact("personal", "next")).toEqual(nextConfig);
    expect(personal.current.models.getExactRule("personal", "next")?.type).toBe(
      "manual-provider-model",
    );
  });

  it("原子 Model Draft 在文件锁内拒绝过期 Personal revision", async () => {
    const personal = new MemoryPersonalRepository(
      layerSnapshot("personal-2", new ProviderConfigMap([["personal", personalProvider(["old"])]])),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await expect(
      service.savePersonalModelDraft(
        "personal",
        "old",
        "next",
        new ModelConfig({ enabled: false }),
        "personal-1",
      ),
    ).rejects.toThrow("Personal Provider Config revision conflict");
    expect(personal.current.providers.get("personal")?.personalModelIds).toEqual(["old"]);
  });

  it("固定模式必须独立完整，拒绝提交时也不能先重命名成员", async () => {
    const personal = new MemoryPersonalRepository(
      layerSnapshot("personal-1", new ProviderConfigMap([["personal", personalProvider(["old"])]])),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });
    await expect(
      service.savePersonalModelDraft(
        "personal",
        "old",
        "next",
        new ModelConfig({ enabled: false }),
        "personal-1",
        false,
      ),
    ).rejects.toThrow(/properties|optionSpecs|contextWindow/);
    expect(personal.current.revision).toBe("personal-1");
    expect(personal.current.providers.get("personal")?.personalModelIds).toEqual(["old"]);
    expect(personal.current.models.getExact("personal", "next")).toBeUndefined();
  });

  it("已有固定模式不能通过省略模式参数绕过完整性校验", async () => {
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["personal", personalProvider(["old"])]]),
        ModelConfigRules.empty().setExact("personal", "old", manualModelConfig(), false),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });
    await expect(
      service.savePersonalModelDraft(
        "personal",
        "old",
        "old",
        new ModelConfig({ enabled: false }),
        "personal-1",
      ),
    ).rejects.toThrow(/properties|optionSpecs|contextWindow/);
    expect(personal.current.revision).toBe("personal-1");
    expect(personal.current.models.getExactRule("personal", "old")?.type).toBe(
      "manual-provider-model",
    );
  });

  it("原子新增 Personal Model，同时写入成员与初始精确配置", async () => {
    const modelConfig = completeModelConfig();
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["personal", personalProvider(["before"])]]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await service.addPersonalModel("personal", "new-model", modelConfig);

    expect(personal.current.providers.get("personal")?.personalModelIds).toEqual([
      "before",
      "new-model",
    ]);
    expect(personal.current.models.getExact("personal", "new-model")).toEqual(modelConfig);
  });

  it("新增 Personal Model 拒绝覆盖 Built-in 或已有 Personal 成员", async () => {
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(
        layerSnapshot(
          "zcodeBuiltin-1",
          new ProviderConfigMap([["personal", localProvider(["builtin-model"])]]),
        ),
      ),
      personalRepository: new MemoryPersonalRepository(
        layerSnapshot(
          "personal-1",
          new ProviderConfigMap([["personal", personalProvider(["personal-model"])]]),
        ),
      ),
    });

    await expect(
      service.addPersonalModel("personal", "builtin-model", completeModelConfig()),
    ).rejects.toThrow("Model 已存在: personal/builtin-model");
    await expect(
      service.addPersonalModel("personal", "personal-model", completeModelConfig()),
    ).rejects.toThrow("Model 已存在: personal/personal-model");
  });

  it("模型重命名拒绝覆盖 Built-in 或已有 Personal 成员", async () => {
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(
        layerSnapshot(
          "zcodeBuiltin-1",
          new ProviderConfigMap([["zcodeBuiltin", localProvider(["managed-model"])]]),
        ),
      ),
      personalRepository: new MemoryPersonalRepository(
        layerSnapshot(
          "personal-1",
          new ProviderConfigMap([
            ["personal", personalProvider(["model-a", "model-b"])],
            ["occupied", personalProvider([])],
          ]),
        ),
      ),
    });

    await expect(service.renamePersonalModel("personal", "model-a", "model-b")).rejects.toThrow(
      "Model 已存在: personal/model-b",
    );
  });

  it("迁移边界可以原子替换完整 Personal Overlay", async () => {
    const personal = new MemoryPersonalRepository(layerSnapshot("personal-1"));
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });
    const providers = new ProviderConfigMap([["personal", personalProvider(["model-a"])]]);
    const models = new ModelConfigRules([
      {
        type: "model",
        modelMatch: "model-a",
        config: completeModelConfig(),
      },
    ]);

    await service.replacePersonalConfig({ providers, models });

    expect(personal.current.providers).toBe(providers);
    expect(personal.current.models).toBe(models);
  });

  it("删除 Personal Model 时原子删除成员和精确规则", async () => {
    const exact = completeModelConfig();
    const pattern = new ModelConfig({
      properties: new ModelPropertiesConfig({ contextWindow: 64_000 }),
    });
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["personal", personalProvider(["keep", "remove"])]]),
        new ModelConfigRules([
          { type: "provider-model", providerId: "personal", modelId: "remove", config: exact },
          { type: "model", modelMatch: ".*", config: pattern },
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await service.deletePersonalModel("personal", "remove");

    expect(personal.current.providers.get("personal")?.personalModelIds).toEqual(["keep"]);
    expect(personal.current.models.getExact("personal", "remove")).toBeUndefined();
    expect(personal.current.models.rules()).toContainEqual({
      type: "model",
      modelMatch: ".*",
      config: pattern,
    });
  });

  it("保存 Personal Provider 不改写任何 Model Rules", async () => {
    const pattern = new ModelConfig({
      properties: new ModelPropertiesConfig({ inputFormat: { supportsImage: true } }),
    });
    const stale = new ModelConfig({
      properties: new ModelPropertiesConfig({ contextWindow: 100_000 }),
    });
    const other = new ModelConfig({
      properties: new ModelPropertiesConfig({ contextWindow: 300_000 }),
    });
    const providerPattern = new ModelConfig({
      properties: new ModelPropertiesConfig({ inputFormat: { supportsPdf: true } }),
    });
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          ["personal", personalProvider(["stale-model"])],
          ["other", personalProvider(["other-model"])],
        ]),
        new ModelConfigRules([
          { type: "model", modelMatch: ".*", config: pattern },
          {
            type: "model",
            modelMatch: "model-.*",
            config: providerPattern,
          },
          {
            type: "model",
            modelMatch: "stale-model",
            config: stale,
          },
          {
            type: "model",
            modelMatch: "other-model",
            config: other,
          },
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await service.savePersonalProviderOverlay("personal", personalProvider(["model-a"]));

    expect(personal.current.providers.get("personal")?.personalModelIds).toEqual(["stale-model"]);
    expect(personal.current.models.rules()).toEqual([
      { type: "model", modelMatch: ".*", config: pattern },
      {
        type: "model",
        modelMatch: "model-.*",
        config: providerPattern,
      },
      { type: "model", modelMatch: "stale-model", config: stale },
      { type: "model", modelMatch: "other-model", config: other },
    ]);
  });

  it("上游变化通知会驱动注入该 Service 的 Registry 刷新", async () => {
    const zcodeBuiltin = new MutableSource(
      layerSnapshot(
        "zcodeBuiltin-1",
        new ProviderConfigMap([["local", localProvider(["model-a"])]]),
        new ModelConfigRules([{ type: "model", modelMatch: ".*", config: completeModelConfig() }]),
      ),
    );
    const personal = new MemoryPersonalRepository(layerSnapshot("personal-1"));
    const configService = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });
    const accountSource = new MutableSource<AccountProviderConfigSnapshot>({
      revision: "account-1",
      basedOnZCodeBuiltinRevision: "zcodeBuiltin-1",
      providers: ProviderConfigMap.empty(),
    });
    const registry = new ProviderRegistryService({
      configSource: configService,
      accountSource,
    });
    const changed = vi.fn();
    registry.onDidChange(changed);
    await registry.start();

    zcodeBuiltin.current = layerSnapshot(
      "zcodeBuiltin-2",
      new ProviderConfigMap([["local", localProvider(["model-b"])]]),
      new ModelConfigRules([{ type: "model", modelMatch: ".*", config: completeModelConfig() }]),
    );
    zcodeBuiltin.emit("catalog-updated");
    accountSource.current = {
      revision: "account-2",
      basedOnZCodeBuiltinRevision: "zcodeBuiltin-2",
      providers: ProviderConfigMap.empty(),
    };
    accountSource.emit("builtin-recomputed");

    await vi.waitFor(() => expect(registry.getModel("local", "model-b")).toBeDefined());
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
