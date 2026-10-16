import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ZhipuAccountAccessConfig,
} from "@zcode/provider";
import { NodeZCodeBuiltinProviderConfigSource } from "../src/index.js";
import { fileURLToPath } from "node:url";

const bundledFilePath = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);

describe("Account preset membership", () => {
  it("trims only individual/team defaults and keeps personal additions executable", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({ bundledFilePath, watch: false });
    try {
      const snapshot = await source.read();
      for (const family of ["zai", "bigmodel"]) {
        for (const mode of ["individual-coding-plan", "team-coding-plan"]) {
          const providerId = `account:${family}-${mode}`;
          expect(snapshot.providers.get(providerId)?.builtinModelIds).toEqual([
            "GLM-5.3",
            "GLM-5.3-Flash",
          ]);
          const result = new ProviderConfigResolver().resolve({
            zcodeBuiltinProviders: snapshot.providers,
            zcodeBuiltinProviderTemplates: snapshot.providerTemplates,
            zcodeBuiltinModelRules: snapshot.models,
            accountProviders: new ProviderConfigMap([
              [
                providerId,
                new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled: true }) }),
              ],
            ]),
            accountStates: {
              [providerId]: { availability: "available", entitled: true, current: true },
            },
            personalModels: ModelConfigRules.empty(),
            personalProviders: new ProviderConfigMap([
              [providerId, new ProviderConfig({ personalModelIds: ["GLM-5.2", "GLM-5-Turbo"] })],
            ]),
          });
          expect(
            result.registryProviders
              .find((p) => p.providerId === providerId)
              ?.models.map((m) => m.modelId),
          ).toEqual(expect.arrayContaining(["GLM-5.2", "GLM-5-Turbo"]));
        }
        expect(snapshot.providers.get(`account:${family}-start-plan`)?.builtinModelIds).toEqual([
          "GLM-5.3-Flash",
          "GLM-5.2",
          "GLM-5-Turbo",
        ]);
        expect(
          snapshot.providers.get(`account:${family}-offpeak-idle-plan`)?.builtinModelIds,
        ).toContain("GLM-5.3-Flash");
      }
      const raw = JSON.parse(await readFile(bundledFilePath, "utf8"));
      expect(
        raw.config.modelConfigRules.modelRules.some((r: { modelMatch: string }) =>
          r.modelMatch.includes("GLM-5-Turbo"),
        ),
      ).toBe(true);
    } finally {
      source.dispose();
    }
  });
});
