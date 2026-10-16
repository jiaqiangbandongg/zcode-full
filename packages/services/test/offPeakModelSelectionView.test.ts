import { join } from "node:path";
import {
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderRegistry,
  ZhipuAccountAccessConfig,
} from "@zcode/provider";
import { NodeZCodeBuiltinProviderConfigSource } from "@zcode/provider-node";
import { describe, expect, it } from "vitest";
import { buildOffPeakModelSelectionView } from "../src/model-provider/offPeakModelSelectionView.js";

describe("buildOffPeakModelSelectionView", () => {
  it("只投影 Registry 中固定的隐藏闲时 Provider", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: join(process.cwd(), "config/provider/zcode-builtin.json"),
      watch: false,
    });
    try {
      const zcodeBuiltin = await source.read();
      const resolution = new ProviderConfigResolver().resolve({
        zcodeBuiltinProviders: zcodeBuiltin.providers,
        zcodeBuiltinModelRules: zcodeBuiltin.models,
        accountProviders: new ProviderConfigMap([
          [
            "account:zai-offpeak-idle-plan",
            new ProviderConfig({
              access: new ZhipuAccountAccessConfig({ entitled: true }),
            }),
          ],
          [
            "account:bigmodel-offpeak-idle-plan",
            new ProviderConfig({
              access: new ZhipuAccountAccessConfig({ entitled: true }),
            }),
          ],
        ]),
        personalProviders: ProviderConfigMap.empty(),
        personalModels: ModelConfigRules.empty(),
      });
      const registry = new ProviderRegistry(resolution.registryProviders);

      const result = buildOffPeakModelSelectionView(registry.getView());

      expect(result.providers).toHaveLength(2);
      expect(result.providers[0]).toMatchObject({
        providerId: "account:zai-offpeak-idle-plan",
        config: {
          visibility: "hidden",
          access: { type: "zhipu-account", accountType: "zai", mode: "off-peak" },
          api: {
            type: "anthropic-messages",
            baseUrl: "https://zcode.z.ai/api/v1/off-peak/anthropic",
          },
        },
      });
      for (const provider of result.providers) {
        expect(provider.models.map((model) => model.modelId)).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
        for (const model of provider.models) {
          const flash = model.modelId === "GLM-5.3-Flash";
          expect(model.config).toMatchObject({
            enabled: true,
            properties: {
              contextWindow: 1_000_000,
              inputFormat: { supportsImage: flash, supportsVideo: flash, supportsPdf: flash },
              supportsNativeWebSearch: false,
              supportsMidConversationSystem: true,
            },
            optionSpecs: {
              reasoningLevel: { values: ["low", "high", "max"], map: expect.any(String) },
              maxOutputTokens: { max: 128000, map: expect.any(String) },
            },
          });
        }
      }
      expect(result.providers[1]).toMatchObject({
        providerId: "account:bigmodel-offpeak-idle-plan",
        config: {
          visibility: "hidden",
          access: { type: "zhipu-account", accountType: "bigmodel", mode: "off-peak" },
        },
      });
    } finally {
      source.dispose();
    }
  });
});
