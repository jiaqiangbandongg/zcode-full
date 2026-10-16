import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProviderConfigMap,
  extractManualModelConfig,
  type AccountProviderConfigSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import {
  NodePersonalProviderConfigRepository,
  NodeZCodeBuiltinProviderConfigSource,
} from "@zcode/provider-node";
import type { ModelSelection } from "@zcode/shared/model-selection";
import { describe, expect, it, vi } from "vitest";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import {
  createProviderRuntime,
  createProviderRuntimeFromConfigRuntime,
} from "../src/model-provider/providerRuntime.js";
import { createAccountProviderConfig } from "./providerConfigFixtures.js";

async function readBuiltinRevision(filePath: string): Promise<string> {
  const source = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: filePath,
    watch: false,
  });
  try {
    return (await source.read()).revision;
  } finally {
    source.dispose();
  }
}

class StaticAccountSource implements ProviderSource<AccountProviderConfigSnapshot> {
  constructor(readonly snapshot: AccountProviderConfigSnapshot) {}

  readonly refresh = vi.fn(async () => this.snapshot);

  async read(): Promise<AccountProviderConfigSnapshot> {
    return this.snapshot;
  }

  onDidChange(): () => void {
    return () => {};
  }
}

describe("ProviderRuntime", () => {
  it("Host View 原子返回 Configured Default 解析后的 preferredSelection", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-runtime-preferred-"));
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    const personalFilePath = join(root, "personal.json");
    await writeFile(
      zcodeBuiltinFilePath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: {
          providerConfigRules: {
            providerRules: [],
            templateRules: [
              {
                templateId: "provider-template",
                templateNameMap: { "en-US": "Provider Template" },
                config: {
                  access: { type: "api-key" },
                  api: { type: "anthropic-messages", baseUrl: "https://example.com" },
                  builtinModelIds: ["model-a", "model-b"],
                },
              },
            ],
          },
          modelConfigRules: {
            modelRules: [
              {
                modelMatch: ".*",
                config: {
                  enabled: true,
                  properties: {
                    requiresMfjsToolSchema: false,
                    contextWindow: 100000,
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
                      values: ["disabled"],
                      map: "{}",
                    },
                    maxOutputTokens: {
                      max: 32000,
                      map: "{'max_tokens': maxOutputTokens}",
                    },
                  },
                },
              },
            ],
            modelApiRules: [],
            providerSiteRules: [],
            templateModelRules: [],
            builtinProviderModelRules: [],
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      personalFilePath,
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "provider",
                templateId: "provider-template",
                config: {
                  group: "standard-personal",
                  access: { type: "api-key", apiKey: "test-key" },
                  personalModelIds: [],
                  modelOrder: [],
                },
              },
            ],
          },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        },
      }),
      "utf8",
    );
    await seedDefault(join(root, "personal.json"), {
      providerId: "provider",
      modelId: "model-b",
      options: { reasoningLevel: "disabled" },
    });
    const runtime = createProviderRuntime({
      zcodeBuiltinFilePath,
      personalFilePath,
      watch: false,
    });

    await expect(runtime.modelSelection.getView()).resolves.toMatchObject({
      preferredSelection: { providerId: "provider", modelId: "model-b" },
    });
    runtime.dispose();
  });

  it("复用组合根先创建的 Config Runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-runtime-injected-config-"));
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    await writeFile(zcodeBuiltinFilePath, JSON.stringify(emptyZCodeBuiltinRelease()), "utf8");
    const configRuntime = createProviderConfigRuntime({
      zcodeBuiltinFilePath,
      personalFilePath: join(root, "personal.json"),
      watch: false,
    });

    const runtime = createProviderRuntimeFromConfigRuntime({ configRuntime });

    expect(runtime.configService).toBe(configRuntime.configService);
    const configStart = vi.spyOn(configRuntime, "start");
    configStart.mockRejectedValueOnce(new Error("first-read-failed"));
    await expect(runtime.start()).rejects.toThrow("first-read-failed");
    const firstStart = runtime.start();
    expect(runtime.start()).toBe(firstStart);
    await expect(firstStart).resolves.toBeUndefined();
    expect(configStart).toHaveBeenCalledTimes(2);
    await expect(configRuntime.start()).resolves.toBeUndefined();
    expect(runtime.registryService.getSnapshot()).toMatchObject({ registry: { providers: [] } });
    const initial = runtime.registryService.getSnapshot()!;
    const created = await runtime.providerSettings.createPersonalProvider({
      providerName: "after-start",
    });
    expect(runtime.start()).toBe(firstStart);
    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.registryService.getSnapshot()).not.toBe(initial);
    expect((await runtime.configService.read()).personalProviders.has(created.providerId)).toBe(
      true,
    );
    await expect(configRuntime.start()).resolves.toBeUndefined();
    expect(
      (await configRuntime.configService.read()).personalProviders.has(created.providerId),
    ).toBe(true);
    runtime.dispose();
    expect(() => runtime.start()).toThrow("已 dispose");
  });

  it("释放组合根拥有的 Account Source", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-runtime-account-dispose-"));
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    await writeFile(zcodeBuiltinFilePath, JSON.stringify(emptyZCodeBuiltinRelease()), "utf8");
    const configRuntime = createProviderConfigRuntime({
      zcodeBuiltinFilePath,
      personalFilePath: join(root, "personal.json"),
      watch: false,
    });
    const disposeAccountSource = vi.fn();
    const runtime = createProviderRuntimeFromConfigRuntime({
      configRuntime,
      disposeAccountSource,
    });

    runtime.dispose();

    expect(disposeAccountSource).toHaveBeenCalledTimes(1);
  });

  it("首次 Facade 调用会等待 Runtime 就绪，无需 Entry 先显式 start", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-runtime-ready-"));
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    await writeFile(zcodeBuiltinFilePath, JSON.stringify(emptyZCodeBuiltinRelease()), "utf8");
    const runtime = createProviderRuntime({
      zcodeBuiltinFilePath,
      personalFilePath: join(root, "personal.json"),
      watch: false,
    });

    await expect(
      Promise.all([runtime.providerSettings.getView(), runtime.modelSelection.getView()]),
    ).resolves.toEqual([
      { revision: 1, providerTemplates: [], providerOrder: [], providers: [] },
      { revision: 1, providers: [] },
    ]);

    runtime.dispose();
  });

  it("组装 Config、Account Access、Registry 与 Facade", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-runtime-"));
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    await writeFile(
      zcodeBuiltinFilePath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "account-plan",
                config: {
                  group: "zai-family",
                  access: {
                    type: "zhipu-account",
                    accountType: "zai",
                    mode: "individual-coding-plan",
                    entitled: false,
                  },
                  api: {
                    type: "anthropic-messages",
                    baseUrl: "https://plan.example.com",
                  },
                  builtinModelIds: ["model-a"],
                },
              },
            ],
            templateRules: [],
          },
          modelConfigRules: {
            modelRules: [
              {
                modelMatch: ".*",
                config: {
                  properties: {
                    requiresMfjsToolSchema: false,
                    contextWindow: 200000,
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
                      values: ["disabled"],
                      map: "{}",
                    },
                    maxOutputTokens: {
                      max: 32000,
                      map: "{'max_tokens': maxOutputTokens}",
                    },
                  },
                  enabled: true,
                },
              },
            ],
            modelApiRules: [],
            providerSiteRules: [],
            templateModelRules: [],
            builtinProviderModelRules: [],
          },
        },
      }),
      "utf8",
    );
    const accountSource = new StaticAccountSource({
      revision: "account-1",
      basedOnZCodeBuiltinRevision: await readBuiltinRevision(zcodeBuiltinFilePath),
      providers: new ProviderConfigMap([
        [
          "account-plan",
          createAccountProviderConfig({
            models: ["model-a"],
            entitled: true,
          }),
        ],
      ]),
    });
    // 首选值必须来自显式 Configured Default；不能依赖已取消的“首个模型自动补档”。
    await seedDefault(join(root, "personal.json"), {
      providerId: "account-plan",
      modelId: "model-a",
      options: { reasoningLevel: "disabled" },
    });
    const runtime = createProviderRuntime({
      zcodeBuiltinFilePath,
      personalFilePath: join(root, "personal.json"),
      accountSource,
      watch: false,
    });

    await runtime.start();
    const snapshot = runtime.registryService.getSnapshot()!;

    expect(snapshot.registry.providers[0]).toMatchObject({
      providerId: "account-plan",
      config: {
        access: {
          type: "zhipu-account",
        },
        builtinModelIds: ["model-a"],
      },
    });
    expect(await runtime.modelSelection.getView()).toEqual({
      revision: 1,
      preferredSelection: {
        providerId: "account-plan",
        modelId: "model-a",
        options: { reasoningLevel: "disabled" },
      },
      providers: [
        {
          providerId: "account-plan",
          config: {
            access: {
              type: "zhipu-account",
              accountType: "zai",
              mode: "individual-coding-plan",
              entitled: true,
            },
            api: {
              type: "anthropic-messages",
              baseUrl: "https://plan.example.com",
            },
            builtinModelIds: ["model-a"],
            group: "zai-family",
          },
          models: [
            {
              modelId: "model-a",
              config: expect.any(Object),
            },
          ],
        },
      ],
    });

    const selectionListener = vi.fn();
    const subscription = runtime.modelSelection.onDidChange(selectionListener);
    expect(subscription).toHaveProperty("dispose");

    await runtime.providerSettings.refresh("account-provider-ready");
    expect((await runtime.modelSelection.getView()).providers).toHaveLength(1);
    subscription.dispose();

    await runtime.providerSettings.refresh("purchase-complete");
    expect(accountSource.refresh).toHaveBeenCalledWith("settings:purchase-complete");

    runtime.dispose();
  });

  it("设置页连通性测试使用最新 Settings Provider 判断账号访问方式", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-runtime-connectivity-"));
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    await writeFile(
      zcodeBuiltinFilePath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "account-plan",
                config: {
                  group: "zai-family",
                  access: {
                    type: "zhipu-account",
                    accountType: "zai",
                    mode: "individual-coding-plan",
                    entitled: false,
                  },
                  api: {
                    type: "anthropic-messages",
                    baseUrl: "https://plan.example.com",
                  },
                  builtinModelIds: ["model-a"],
                },
              },
            ],
            templateRules: [],
          },
          modelConfigRules: {
            modelRules: [
              {
                modelMatch: ".*",
                config: {
                  properties: {
                    requiresMfjsToolSchema: false,
                    contextWindow: 200000,
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
                      values: ["disabled"],
                      map: "{}",
                    },
                    maxOutputTokens: {
                      max: 32000,
                      map: "{'max_tokens': maxOutputTokens}",
                    },
                  },
                  enabled: true,
                },
              },
            ],
            modelApiRules: [],
            providerSiteRules: [],
            templateModelRules: [],
            builtinProviderModelRules: [],
          },
        },
      }),
      "utf8",
    );
    const accountSource = new StaticAccountSource({
      revision: "account-1",
      basedOnZCodeBuiltinRevision: await readBuiltinRevision(zcodeBuiltinFilePath),
      providers: new ProviderConfigMap([
        [
          "account-plan",
          createAccountProviderConfig({
            models: ["model-a"],
            entitled: true,
          }),
        ],
      ]),
    });
    const testConnectivity = vi.fn(async () => ({ success: true as const }));
    const runtime = createProviderRuntime({
      zcodeBuiltinFilePath,
      personalFilePath: join(root, "personal.json"),
      accountSource,
      testConnectivity,
      watch: false,
    });
    const settingsView = await runtime.providerSettings.getView();
    const provider = settingsView.providers.find(
      (candidate) => candidate.providerId === "account-plan",
    )!;
    const model = provider.models.find((candidate) => candidate.modelId === "model-a")!;

    await runtime.providerSettings.testModelConnectivity({
      workspacePath: "/remote/workspace",
      workspaceIdentity: "ssh:server:/remote/workspace",
      providerId: provider.providerId,
      modelId: model.modelId,
    });

    expect(testConnectivity).toHaveBeenCalledWith({
      workspacePath: "/remote/workspace",
      workspaceIdentity: "ssh:server:/remote/workspace",
      providerId: "account-plan",
      modelId: "model-a",
    });
    runtime.dispose();
  });

  it.each([undefined, true, false])(
    "原子新增 Personal Model 完整贯穿模式 %s",
    async (recommended) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-provider-runtime-direct-save-"));
      const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
      // 手动规则只包含开放编辑的叶子；MFJS 等隐藏能力和 maxOutput Map 必须来自 Built-in。
      await writeFile(
        zcodeBuiltinFilePath,
        JSON.stringify(
          emptyZCodeBuiltinRelease({
            properties: {
              requiresMfjsToolSchema: false,
              inputFormat: { supportsText: true, supportsAudio: false },
              outputFormat: { supportsText: true },
              supportsToolCall: true,
            },
            optionSpecs: { maxOutputTokens: { map: "{'max_tokens': maxOutputTokens}" } },
          }),
        ),
        "utf8",
      );
      const runtime = createProviderRuntime({
        zcodeBuiltinFilePath,
        personalFilePath: join(root, "personal.json"),
        watch: false,
      });
      const created = await runtime.providerSettings.createPersonalProvider();
      await runtime.providerSettings.savePersonalProviderOverlay(created.providerId, {
        access: { type: "api-key", apiKey: "secret" },
        api: { type: "anthropic-messages", baseUrl: "https://api.example.com" },
        personalModelIds: ["model-a"],
      });
      const config = {
        properties: {
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
        },
        optionSpecs: {
          reasoningLevel: {
            values: ["disabled"],
            map: "{}",
          },
          maxOutputTokens: {
            max: 32_000,
            map: "{'max_tokens': maxOutputTokens}",
          },
        },
        enabled: true,
      };
      await runtime.providerSettings.addPersonalModel(
        created.providerId,
        "model-a",
        recommended === false ? extractManualModelConfig(config) : config,
        recommended,
      );

      expect(
        (await runtime.configService.read()).personalModels.getExactRule(
          created.providerId,
          "model-a",
        )?.type,
      ).toBe(recommended === false ? "manual-provider-model" : "provider-model");
      if (recommended === false) {
        expect(
          (await runtime.configService.read()).personalModels.getExact(
            created.providerId,
            "model-a",
          )?.properties?.requiresMfjsToolSchema,
        ).toBeUndefined();
        expect(
          runtime.registryService.getModel(created.providerId, "model-a")?.config.properties
            ?.requiresMfjsToolSchema,
        ).toBe(false);
        await expect(
          runtime.providerSettings.addPersonalModel(created.providerId, "broken-fixed", {}, false),
        ).rejects.toThrow(/properties|optionSpecs/);
        expect(
          (await runtime.configService.read()).personalProviders.get(created.providerId)
            ?.personalModelIds,
        ).not.toContain("broken-fixed");
      }

      expect(runtime.registryService.getProvider(created.providerId)?.config).toMatchObject({
        access: { type: "api-key", apiKey: "secret" },
        api: {
          type: "anthropic-messages",
          baseUrl: "https://api.example.com",
        },
      });
      expect(runtime.registryService.getModel(created.providerId, "model-a")?.config).toMatchObject(
        {
          properties: { contextWindow: 200_000 },
          optionSpecs: {
            reasoningLevel: {
              values: ["disabled"],
              map: "{}",
            },
            maxOutputTokens: { max: 32_000, map: "{'max_tokens': maxOutputTokens}" },
          },
        },
      );

      expect(runtime.registryService.getProvider(created.providerId)?.config.label).toBeUndefined();
      runtime.dispose();
    },
  );

  it("设置服务创建 Personal Provider 后返回 Registry 已观察到的视图", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-runtime-create-"));
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    await writeFile(zcodeBuiltinFilePath, JSON.stringify(emptyZCodeBuiltinRelease()), "utf8");
    const runtime = createProviderRuntime({
      zcodeBuiltinFilePath,
      personalFilePath: join(root, "personal.json"),
      watch: false,
    });

    const created = await runtime.providerSettings.createPersonalProvider();

    expect(created.providerId).toBe("new-provider");
    expect(created.view.providers).toContainEqual(
      expect.objectContaining({
        providerId: "new-provider",
        executable: false,
      }),
    );
    runtime.dispose();
  });

  it("保存 ZCode Built-in Provider 时只写明确提交的 Personal Overlay", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-runtime-official-save-"));
    const zcodeBuiltinFilePath = join(root, "zcode-builtin.json");
    await writeFile(
      zcodeBuiltinFilePath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: {
          providerConfigRules: {
            providerRules: [],
            templateRules: [
              {
                templateId: "builtin:demo",
                templateNameMap: { "en-US": "Official Demo" },
                config: {
                  access: { type: "api-key" },
                  api: {
                    type: "anthropic-messages",
                    baseUrl: "https://api.example.com",
                  },
                  builtinModelIds: ["demo-model"],
                },
              },
            ],
          },
          modelConfigRules: {
            modelRules: [],
            modelApiRules: [],
            providerSiteRules: [],
            templateModelRules: [
              {
                templateId: "builtin:demo",
                modelId: "demo-model",
                config: {
                  properties: {
                    requiresMfjsToolSchema: false,
                    contextWindow: 200000,
                    inputFormat: {
                      supportsText: true,
                      supportsImage: false,
                      supportsVideo: false,
                      supportsAudio: false,
                      supportsPdf: false,
                    },
                    outputFormat: { supportsText: true },
                    supportsToolCall: true,
                    supportsJsonSchemaOutput: false,
                    supportsNativeWebSearch: false,
                    supportsMidConversationSystem: false,
                  },
                  optionSpecs: {
                    reasoningLevel: {
                      values: ["disabled"],
                      map: "{}",
                    },
                    maxOutputTokens: {
                      max: 32000,
                      map: "{'max_tokens': maxOutputTokens}",
                    },
                  },
                  enabled: true,
                },
              },
            ],
            builtinProviderModelRules: [],
          },
        },
      }),
      "utf8",
    );
    const runtime = createProviderRuntime({
      zcodeBuiltinFilePath,
      personalFilePath: join(root, "personal.json"),
      watch: false,
    });

    const created = await runtime.providerSettings.createPersonalProvider({
      templateId: "builtin:demo",
      initialConfig: { access: { type: "api-key", apiKey: "personal-secret" } },
    });
    await runtime.providerSettings.savePersonalModelDraft({
      providerId: created.providerId,
      originalModelId: "demo-model",
      nextModelId: "demo-model",
      personalConfig: { properties: { contextWindow: 128_000 } },
      basedOnRevision: (await runtime.providerSettings.getView()).revision,
    });

    const configSnapshot = await runtime.configService.read();
    expect(configSnapshot.personalProviders.getRule(created.providerId)).toMatchObject({
      templateId: "builtin:demo",
      providerName: "Official Demo",
    });
    expect(configSnapshot.personalProviders.get(created.providerId)?.toJSON()).toEqual({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "personal-secret" },
      personalModelIds: [],
      modelOrder: [],
    });
    expect(
      configSnapshot.personalModels.getExact(created.providerId, "demo-model")?.toJSON(),
    ).toEqual({ properties: { contextWindow: 128_000 } });
    runtime.dispose();
  });
});

function emptyZCodeBuiltinRelease(modelDefaults: object = {}): object {
  return {
    schemaVersion: 1,
    revision: 1,
    config: {
      providerConfigRules: { providerRules: [], templateRules: [] },
      modelConfigRules: {
        modelRules: [{ modelMatch: ".*", config: modelDefaults }],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  };
}

async function seedDefault(filePath: string, defaultModelSelection: ModelSelection) {
  const repository = new NodePersonalProviderConfigRepository({
    filePath,
    pollingIntervalMs: false,
  });
  try {
    await repository.update((current) => ({ ...current, defaultModelSelection }));
  } finally {
    repository.dispose();
  }
}
