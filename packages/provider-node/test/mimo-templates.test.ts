import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileModelOptionMaps } from "@zcode/model-option-map";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
} from "@zcode/provider";
import { NodeZCodeBuiltinProviderConfigSource } from "@zcode/provider-node";

const currentModelIds = ["mimo-v2.6-pro", "mimo-v2.6-flash"];
const apiModelIds = [...currentModelIds, "mimo-v2.5-pro", "mimo-v2.5"];

const templates = [
  ["xiaomi-mimo", "Xiaomi MiMo API", "https://api.xiaomimimo.com/anthropic"],
  [
    "xiaomi-mimo-token-plan",
    "Xiaomi MiMo Token Plan",
    "https://token-plan-cn.xiaomimimo.com/anthropic",
  ],
] as const;

describe("MiMo API 与 Token Plan 官方模板", () => {
  it.each(["zcode-builtin.json", "zcode-builtin.test.json"])(
    "%s 两模板复用模型规则，个人地址与旧身份不变",
    async (filename) => {
      const source = new NodeZCodeBuiltinProviderConfigSource({
        bundledFilePath: fileURLToPath(
          new URL(`../../../config/provider/${filename}`, import.meta.url),
        ),
        watch: false,
      });
      try {
        const snapshot = await source.read();
        for (const [templateId, name, baseUrl] of templates) {
          const template = snapshot.providerTemplates?.get(templateId);
          expect(template, templateId).toBeDefined();
          expect(template!.templateNameMap).toEqual({ "zh-CN": name, "en-US": name });
          expect(template!.config.api?.toJSON()).toEqual({ type: "anthropic-messages", baseUrl });
          expect(template!.config.access?.toJSON()).toEqual({
            type: "api-key",
            apiKeyManagementUrl: "https://platform.xiaomimimo.com/",
          });
          expect(template!.config.builtinModelIds).toEqual(
            templateId === "xiaomi-mimo" ? apiModelIds : currentModelIds,
          );
          expect(template!.config.logo).toEqual({ type: "builtin", key: "xiaomi-mimo" });
          for (const modelId of template!.config.builtinModelIds!) {
            const model = snapshot.models.resolve({
              providerId: "test",
              templateId,
              modelId,
              apiType: "anthropic-messages",
              baseUrl,
            });
            expect(model.validateComplete()).toEqual([]);
            expect(model.enabled).toBe(true);
            expect(model.properties?.contextWindow).toBe(1000000);
            expect(model.properties?.inputFormat.toJSON()).toMatchObject({
              supportsImage: modelId !== "mimo-v2.5-pro",
              supportsVideo: modelId !== "mimo-v2.5-pro",
              supportsAudio: modelId !== "mimo-v2.5-pro",
            });
            expect(model.optionSpecs?.maxOutputTokens?.max).toBe(131072);
            expect(model.optionSpecs?.reasoningLevel?.values).toEqual(["disabled", "enabled"]);
            for (const reasoningLevel of ["disabled", "enabled"]) {
              expect(
                compileModelOptionMaps({
                  reasoningLevel: { map: model.optionSpecs!.reasoningLevel!.map! },
                  maxOutputTokens: { map: model.optionSpecs!.maxOutputTokens!.map! },
                }).apply({}, { reasoningLevel, maxOutputTokens: 1024 }),
              ).toEqual({
                thinking: { type: reasoningLevel },
                max_tokens: 1024,
              });
            }
          }
        }

        // 旧实例可能已手动填 Token Plan 地址；拆模板不能重命名、重新启用或覆盖其地址。
        const personal = new ProviderConfigMap([
          ...templates.map(([templateId]) => ({
            providerId: `new-${templateId}`,
            templateId,
            config: new ProviderConfig({
              group: "standard-personal",
              access: new ApiKeyAccessConfig({ apiKey: `test-${templateId}` }),
            }),
          })),
          {
            providerId: "legacy-mimo",
            templateId: "xiaomi-mimo",
            providerName: "My MiMo",
            enabled: false,
            config: new ProviderConfig({
              api: new ProviderApiConfig({ baseUrl: templates[1][2] }),
              access: new ApiKeyAccessConfig({ apiKey: "old-test-only" }),
            }),
          },
          {
            providerId: "international-mimo",
            templateId: "xiaomi-mimo-token-plan",
            config: new ProviderConfig({
              group: "standard-personal",
              api: new ProviderApiConfig({
                baseUrl: "https://token-plan-sgp.xiaomimimo.com/anthropic",
              }),
              access: new ApiKeyAccessConfig({ apiKey: "test-only" }),
            }),
          },
        ]);
        const before = personal.toJSON();
        const resolution = new ProviderConfigResolver().resolve({
          zcodeBuiltinProviders: ProviderConfigMap.empty(),
          zcodeBuiltinProviderTemplates: snapshot.providerTemplates,
          accountProviders: ProviderConfigMap.empty(),
          personalProviders: personal,
          zcodeBuiltinModelRules: snapshot.models,
          personalModels: new ModelConfigRules([
            {
              type: "provider-model",
              providerId: "international-mimo",
              modelId: "mimo-v2.6-pro",
              config: new ModelConfig({ enabled: false }),
            },
          ]),
        });
        for (const [templateId, , baseUrl] of templates) {
          const provider = resolution.registryProviders.find(
            (p) => p.providerId === `new-${templateId}`,
          );
          expect(provider?.config.api?.baseUrl).toBe(baseUrl);
          expect(provider?.models.map((m) => m.modelId)).toEqual(
            templateId === "xiaomi-mimo" ? apiModelIds : currentModelIds,
          );
          expect(provider?.config.access?.toJSON()).toMatchObject({
            apiKey: `test-${templateId}`,
          });
        }
        expect(
          resolution.registryProviders.find((p) => p.providerId === "international-mimo")?.config
            .api?.baseUrl,
        ).toBe("https://token-plan-sgp.xiaomimimo.com/anthropic");
        expect(
          resolution.registryProviders
            .find((p) => p.providerId === "international-mimo")
            ?.models.map((m) => m.modelId),
        ).toEqual(["mimo-v2.6-flash"]);
        expect(resolution.registryProviders.some((p) => p.providerId === "legacy-mimo")).toBe(
          false,
        );
        const legacy = resolution.resolvedProviders.find((p) => p.providerId === "legacy-mimo");
        expect(legacy?.config.access?.toJSON()).toMatchObject({ apiKey: "old-test-only" });
        expect(legacy?.providerName).toBe("My MiMo");
        expect(legacy?.config.api?.baseUrl).toBe(templates[1][2]);
        expect(personal.toJSON()).toEqual(before);
      } finally {
        source.dispose();
      }
    },
  );
});
