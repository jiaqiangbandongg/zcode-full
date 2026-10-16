import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ApiKeyAccessConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
} from "@zcode/provider";
import {
  NodePersonalProviderConfigRepository,
  NodeZCodeBuiltinProviderConfigSource,
} from "@zcode/provider-node";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";
import { readLegacyZCodeConfigProviders } from "../src/model-provider/legacyZCodeConfigProviderReader.js";
import { importLegacyPersonalProviderConfig } from "../src/model-provider/legacyPersonalProviderConfigImporter.js";

let directory: string | undefined;
afterEach(async () => {
  setDataBaseDir(null);
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("Todo 72 已发布 config.json 首次升级", () => {
  it.each([
    { label: "外层禁用优先", fields: { enabled: false, zcode: { enabled: true } }, enabled: false },
    { label: "外层启用优先", fields: { enabled: true, zcode: { enabled: false } }, enabled: true },
    { label: "扩展禁用", fields: { zcode: { enabled: false } }, enabled: false },
    { label: "缺省启用", fields: {}, enabled: undefined },
  ])("Todo118：$label 的首次导入保留启停，旧文件和后续编辑不变", async ({ fields, enabled }) => {
    directory = await mkdtemp(join(tmpdir(), "zcode-legacy-provider-upgrade-"));
    setDataBaseDir(directory);
    const configDir = getAppConfigDir();
    await mkdir(configDir, { recursive: true });
    const customId = "00000000-0000-4000-8000-000000000001";
    // 脱敏复刻同事附件：provider map、source=custom、Key 在 options，模型配置为 object。
    // 不拷贝附件 Token、账号数据或私人 Endpoint。
    const ids = [
      "builtin:bigmodel",
      "builtin:zai",
      "builtin:bigmodel-coding-plan",
      "builtin:zai-coding-plan",
      "builtin:bigmodel-start-plan",
      "builtin:zai-start-plan",
      "builtin:zapi",
      customId,
    ];
    const oldText = JSON.stringify({
      provider: Object.fromEntries(
        ids.map((id) => [
          id,
          {
            name: "Legacy name",
            kind: "anthropic",
            source: "custom",
            ...(id === customId
              ? fields
              : {
                  enabled: false,
                  ...(fields.enabled === true
                    ? { systemDisabledReason: "coding_plan_auth_failed" }
                    : {}),
                }),
            options: { apiKey: `fake-${id}`, baseURL: "https://obsolete.example.test/anthropic" },
            models: {
              "GLM-5.3": {
                limit: { context: 64_000, output: 8_000 },
                modalities: { input: ["text", "video"], output: ["text"] },
              },
            },
          },
        ]),
      ),
    });
    const oldPath = join(configDir, "config.json");
    await writeFile(oldPath, oldText);
    let importCount = 0;
    const repository = new NodePersonalProviderConfigRepository({
      filePath: join(configDir, "provider_config.json"),
      pollingIntervalMs: false,
      importLegacy: async () => {
        importCount++;
        return importLegacyPersonalProviderConfig({
          legacyProviders: await readLegacyZCodeConfigProviders(),
        });
      },
    });
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: fileURLToPath(
        new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
      ),
      watch: false,
    });
    try {
      const personal = await repository.read();
      expect(personal.providers.keys()).toEqual(["bigmodel-api", "zai-api", customId]);
      const builtin = await source.read();
      const resolved = new ProviderConfigResolver().resolve({
        zcodeBuiltinProviders: builtin.providers,
        zcodeBuiltinProviderTemplates: builtin.providerTemplates,
        zcodeBuiltinModelRules: builtin.models,
        personalProviders: personal.providers,
        personalModels: personal.models,
        accountProviders: ProviderConfigMap.empty(),
      });
      for (const family of ["bigmodel", "zai"] as const) {
        const id = `${family}-api`;
        const provider = resolved.resolvedProviders.find((item) => item.providerId === id)!;
        expect(provider.config.api?.baseUrl).toBe(
          builtin.providerTemplates?.get(id)?.config.api?.baseUrl,
        );
        // Todo112 规范了当前模板的官方 ID；旧配置导入仍保留 Key 与旧文件，不沿用旧名单大小写。
        expect(provider.models.some((model) => model.modelId === "GLM-5.3")).toBe(true);
        expect(provider.models.find((model) => model.modelId === "GLM-5.3")?.executable).toBe(true);
        expect(personal.providers.get(id)?.toJSON()).toEqual({
          group: "standard-personal",
          access: { type: "api-key", apiKey: `fake-builtin:${family}` },
        });
        expect(personal.providers.getRule(id)?.templateId).toBe(id);
      }
      expect(personal.models.getExact(customId, "GLM-5.3")?.properties?.contextWindow).toBe(64_000);
      expect(personal.providers.getRule(customId)?.enabled).toBe(enabled);
      expect(personal.providers.get(customId)?.toJSON()).not.toHaveProperty("enabled");
      const custom = resolved.resolvedProviders.find((item) => item.providerId === customId)!;
      expect(custom.enabled).toBe(enabled ?? true);
      expect(custom.models.find((item) => item.modelId === "GLM-5.3")?.executable).toBe(
        enabled ?? true,
      );
      expect(resolved.registryProviders.some((item) => item.providerId === customId)).toBe(
        enabled ?? true,
      );
      const missingKey = new ProviderConfigResolver().resolve({
        zcodeBuiltinProviders: builtin.providers,
        zcodeBuiltinProviderTemplates: builtin.providerTemplates,
        zcodeBuiltinModelRules: builtin.models,
        personalProviders: personal.providers.setRule({
          ...personal.providers.getRule(customId)!,
          enabled: true,
          config: personal.providers
            .get(customId)!
            .overlay(new ProviderConfig({ access: new ApiKeyAccessConfig({ apiKey: "" }) })),
        }),
        personalModels: personal.models,
        accountProviders: ProviderConfigMap.empty(),
      });
      expect(missingKey.registryProviders.some((item) => item.providerId === customId)).toBe(false);
      await repository.update((current) => ({
        ...current,
        providers: current.providers.delete("bigmodel-api").setRule({
          ...current.providers.getRule(customId)!,
          enabled: !(enabled ?? true),
        }),
      }));
      expect((await repository.read()).providers.has("bigmodel-api")).toBe(false);
      const reopened = new NodePersonalProviderConfigRepository({
        filePath: join(configDir, "provider_config.json"),
        pollingIntervalMs: false,
        importLegacy: async () => {
          importCount++;
          return importLegacyPersonalProviderConfig({
            legacyProviders: await readLegacyZCodeConfigProviders(),
          });
        },
      });
      try {
        const persisted = await reopened.read();
        expect(persisted.providers.getRule(customId)?.enabled).toBe(!(enabled ?? true));
        expect(persisted.providers.has("bigmodel-api")).toBe(false);
      } finally {
        reopened.dispose();
      }
      expect(importCount).toBe(1);
      expect(await readFile(oldPath, "utf8")).toBe(oldText);
    } finally {
      repository.dispose();
      source.dispose();
    }
  });
});
